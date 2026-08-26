/**
 * `WalletStreamService` — wallet-backed counterpart of the Node
 * `StreamService` (sdk/client.ts). All transactions are executed by the
 * Shield wallet (`executeTransaction` / `executeDeployment`) and all records
 * come from the wallet (`requestRecords` + `decrypt`); mapping reads go
 * through an `AleoNetworkClient`, exactly as in the Node SDK.
 */

import { Address, AleoNetworkClient, SealanceMerkleTree } from "@provablehq/sdk/testnet.js";
import type { TransactionStatusResponse } from "@provablehq/aleo-types";
import type { AleoDeployment } from "@provablehq/aleo-wallet-standard";

import { streamRefKey, whitelistKey } from "../../../sdk/hashing.ts";
import {
  computeAutoWithdrawalFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  nowSeconds,
  SPLIT_FEE,
  type WithdrawableAmounts,
} from "../../../sdk/math.ts";
import {
  configToPlaintext,
  createStreamParamsToPlaintext,
  fieldLiteral,
  identLiteral,
  parseBoolLiteral,
  parseFieldLiteral,
  parseIntLiteral,
  parseStream,
  parseStreamConfig,
  parseSenderTicket,
  parseStreamAnchor,
  streamToPlaintext,
  streamAnchorToPlaintext,
  streamTokenFeeToPlaintext,
} from "../../../sdk/plaintext.ts";
import { signStreamTokenFee } from "../../../sdk/signing.ts";
import type {
  Config,
  CreateStreamParams,
  Stream,
  StreamConfig,
  StreamAnchor,
  StreamTokenFee,
} from "../../../sdk/types.ts";

import {
  CONFIG_NAME,
  CREDITS_PROGRAM_ID,
  DEFAULT_FEE,
  DYNAMIC_DISPATCH_IMPORTS,
  FREEZE_LIST_URL,
  HOST,
  PROGRAM_ID,
  STREAM_FEE_AMOUNT,
  TOKEN_PROGRAM,
  TOKEN_PROGRAM_ID,
} from "../config.ts";

/** Subset of the `useWallet()` context the service needs. */
export interface StreamWallet {
  address: string;
  requestRecords(program: string, includePlaintext?: boolean): Promise<unknown[]>;
  decrypt(ciphertext: string): Promise<string>;
  executeTransaction(options: {
    program: string;
    function: string;
    inputs: string[];
    fee?: number;
    privateFee?: boolean;
    /**
     * Program names the wallet must load as external stacks for
     * `call.dynamic` dispatch. See `DYNAMIC_DISPATCH_IMPORTS`.
     */
    imports?: string[];
  }): Promise<{ transactionId: string } | undefined>;
  transactionStatus(transactionId: string): Promise<TransactionStatusResponse>;
  executeDeployment(deployment: AleoDeployment): Promise<{ transactionId: string }>;
}

export type TicketRecordName =
  | "SenderStreamTicket"
  | "ReceiverStreamTicket"
  | "WithdrawerStreamTicket";

export interface TicketInfo {
  kind: TicketRecordName;
  /** Bare digits of the stream id (no `field` suffix). */
  streamId: string;
  plaintext: string;
}

export interface PrivateStreamRef {
  streamId: string;
  direction: "outgoing" | "incoming";
  ticketKind: TicketRecordName;
  ticketPlaintext: string;
}

/** One entry of {@link WalletStreamService.listMyPublicStreams}. */
export interface PublicStreamEntry {
  streamId: string;
  direction: "outgoing" | "incoming" | "both";
  anchor?: StreamAnchor | undefined;
  stream?: Stream | undefined;
}

const TX_TIMEOUT_MS = 600_000;
const TX_POLL_MS = 2_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Random 128-bit value for stream ids / price nonces (a `field`). */
function randomField(): bigint {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return BigInt(
    "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}

/** `microcredits:`/`amount:` style member extraction from record plaintext. */
function recordAmount(plaintext: string, member: string): bigint | undefined {
  const match = new RegExp(`${member}:\\s*(\\d+)(?:u64|u128)`).exec(plaintext);
  return match ? BigInt(match[1]!) : undefined;
}

/**
 * Record plaintexts do not carry the record name, but every stream ticket
 * carries a `ticket_type` member (ported from sdk/records.ts): 0 = sender,
 * 1 = receiver, 2 = withdrawer.
 */
const TICKET_KIND_BY_TYPE: Record<number, TicketRecordName> = {
  0: "SenderStreamTicket",
  1: "ReceiverStreamTicket",
  2: "WithdrawerStreamTicket",
};

function classifyTicket(text: string): TicketRecordName | undefined {
  const match = /ticket_type:\s*(\d+)u8/.exec(text);
  if (match === null) return undefined;
  return TICKET_KIND_BY_TYPE[Number(match[1])];
}

function matchesTicket(text: string, recordName: TicketRecordName): boolean {
  return classifyTicket(text) === recordName;
}

export class WalletStreamService {
  readonly wallet: StreamWallet;
  readonly networkClient: AleoNetworkClient;
  private programAddress: string | undefined;

  constructor(wallet: StreamWallet) {
    this.wallet = wallet;
    this.networkClient = new AleoNetworkClient(HOST);
  }

  get address(): string {
    return this.wallet.address;
  }

  // =======================================================================
  // User: stream lifecycle
  // =======================================================================

  /**
   * Execute `create_stream_private` through the wallet. Full flow ported from
   * scripts/stream.ts:createStream — on-chain config read, admin-signed
   * stream fee, Sealance compliance proofs, and credit/token record selection
   * from the wallet.
   *
   * `adminKey` is the config admin's private key, used only to sign the
   * stream fee attestation (never stored).
   */
  async createStreamPrivate(
    params: CreateStreamParams,
    adminKey: string,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
    const config = await this.getConfigInput();

    // Build the admin-signed stream fee attestation from the flat fee amount.
    const tokenFee: StreamTokenFee = {
      config: CONFIG_NAME,
      streamToken: TOKEN_PROGRAM,
      streamFeeAmount: STREAM_FEE_AMOUNT,
      expiry: nowSeconds() + 3600n,
      nonce: randomField(),
    };
    const feeSignature = signStreamTokenFee(adminKey, tokenFee);

    // The credit record must cover the auto-withdrawal fee, the stream fee,
    // and the 10k microcredit burn from credits.aleo::split. The fee mirror
    // multiplies before dividing, exactly like the on-chain helper — a lower
    // estimate would fail the coverage assert during proving.
    const autoWithdrawalFee = params.autoWithdrawable
      ? computeAutoWithdrawalFee(
          params.duration,
          params.withdrawFrequency,
          config.baseFee,
          config.platformFee,
        )
      : 0n;
    console.log("auto-withdrawal fee:", autoWithdrawalFee, "stream fee:", STREAM_FEE_AMOUNT, "split burn:", SPLIT_FEE);
    const creditRecord = await this.findCredits(autoWithdrawalFee + STREAM_FEE_AMOUNT + SPLIT_FEE);
    console.log("credit record:", creditRecord);
    const tokenRecord = await this.findToken(depositAmount);
    console.log("token record:", tokenRecord);
    const merkleProofs = await this.getComplianceProofs();
    console.log("merkle proofs:", merkleProofs);
    
    const inputs = [
      createStreamParamsToPlaintext(params),
      identLiteral(TOKEN_PROGRAM),
      configToPlaintext(config),
      streamTokenFeeToPlaintext(tokenFee),
      feeSignature,
      creditRecord,
      tokenRecord,
      merkleProofs,
    ];
    return this.execute("create_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /** Execute `pause_resume_stream_private` (toggles pause/resume). */
  async pauseResumeStream(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const ticket = await this.findTicket("SenderStreamTicket", streamId);
    return this.execute("pause_resume_stream_private", [ticket], fee);
  }

  /** Execute `cancel_stream_private`. */
  async cancelStream(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const ticket = await this.findTicket("SenderStreamTicket", streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticket, streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
    return this.execute("cancel_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /** Execute `withdraw_stream_private`. */
  async withdraw(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const ticket = await this.findTicket("ReceiverStreamTicket", streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticket, streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
    return this.execute("withdraw_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /**
   * Execute `withdraw_stream_auto_private`: pay out the receiver's accrued
   * amount on behalf of the receiver. Withdrawer only — the withdrawer ticket
   * record and on-chain anchor are resolved automatically.
   */
  async withdrawAuto(
    streamId: string | bigint,
    config: Config,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const now = nowSeconds();
    const ticket = await this.findTicket("WithdrawerStreamTicket", streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      ticket,
      configToPlaintext(config),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    return this.execute("withdraw_stream_auto_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /**
   * Execute `topup_stream_private`: pay the accrued debt of a buffer-mode
   * stream plus `extra` pre-paid coverage. Sender only; no admin key or
   * price attestation needed (top-ups carry no platform fee).
   */
  async topupStream(
    streamId: string | bigint,
    extra: bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const now = nowSeconds();
    const ticket = await this.findTicket("SenderStreamTicket", streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const { fullAmount } = parseSenderTicket(ticket);
    const { topupAmount } = computeTopupAmount(anchor, fullAmount, now, extra);
    console.log("topup amount (debt + extra):", topupAmount);
    const tokenRecord = await this.findToken(topupAmount);
    const merkleProofs = await this.getComplianceProofs();
    const inputs = [
      ticket,
      streamAnchorToPlaintext(anchor),
      `${extra}u128`,
      `${now}i64`,
      tokenRecord,
      merkleProofs,
    ];
    return this.execute("topup_stream_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /**
   * Execute `create_stream_public` through the wallet. The token deposit is
   * pulled from the signer's public balance (the program calls
   * `IARC22::transfer_from_public`), so no credit/token records or compliance
   * proofs are needed — the employer must have approved this program on the
   * token and hold enough public credits for the fees.
   */
  async createStreamPublic(
    params: CreateStreamParams,
    adminKey: string,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const config = await this.getConfigInput();

    // Build the admin-signed stream fee attestation from the flat fee amount.
    const tokenFee: StreamTokenFee = {
      config: CONFIG_NAME,
      streamToken: TOKEN_PROGRAM,
      streamFeeAmount: STREAM_FEE_AMOUNT,
      expiry: nowSeconds() + 3600n,
      nonce: randomField(),
    };
    const feeSignature = signStreamTokenFee(adminKey, tokenFee);

    const inputs = [
      createStreamParamsToPlaintext(params),
      identLiteral(TOKEN_PROGRAM),
      configToPlaintext(config),
      streamTokenFeeToPlaintext(tokenFee),
      feeSignature,
    ];
    return this.execute("create_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /** Execute `pause_resume_stream_public` (toggles pause/resume). */
  async pauseResumeStreamPublic(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    return this.execute("pause_resume_stream_public", [fieldLiteral(streamId)], fee);
  }

  /** Execute `cancel_stream_public`. Stream + anchor resolved automatically. */
  async cancelStreamPublic(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const now = nowSeconds();
    const stream = await this.getStream(streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      streamToPlaintext(stream),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    return this.execute("cancel_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /** Execute `withdraw_stream_public`. Stream + anchor resolved automatically. */
  async withdrawPublic(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const now = nowSeconds();
    const stream = await this.getStream(streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      streamToPlaintext(stream),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    return this.execute("withdraw_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /**
   * Execute `topup_stream_public`: pay the accrued debt of a buffer-mode
   * public stream plus `extra` pre-paid coverage. The connected wallet must
   * be the stream's sender and must have approved this program on the token
   * (the deposit is pulled from the sender's public balance via
   * `IARC22::transfer_from_public` — see `WalletArc22Service.approve`).
   * Stream + anchor resolved automatically.
   */
  async topupStreamPublic(
    streamId: string | bigint,
    extra: bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const now = nowSeconds();
    const stream = await this.getStream(streamId);
    const anchor = await this.getStreamAnchor(streamId);
    // Fail fast when there is nothing to pay: the on-chain entry asserts
    // `debt_amount + extra > 0` with the same pause-aware debt math.
    const { topupAmount } = computeTopupAmount(anchor, stream.fullAmount, now, extra);
    if (topupAmount <= 0n) {
      throw new Error("top-up amount is zero: no accrued debt and no extra pre-payment");
    }
    const inputs = [
      streamToPlaintext(stream),
      streamAnchorToPlaintext(anchor),
      `${extra}u128`,
      `${now}i64`,
    ];
    return this.execute("topup_stream_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /**
   * Execute `withdraw_stream_auto_public`: pay out the receiver's accrued
   * amount on behalf of the receiver. Withdrawer only — the connected wallet
   * must be the config's withdrawer. Stream + anchor resolved automatically.
   */
  async withdrawAutoPublic(
    streamId: string | bigint,
    config: Config,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const now = nowSeconds();
    const stream = await this.getStream(streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      streamToPlaintext(stream),
      configToPlaintext(config),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    return this.execute("withdraw_stream_auto_public", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  // =======================================================================
  // Admin: configuration management
  // =======================================================================

  /** Execute `initialize_config` (one-time, caller becomes config admin). */
  async initializeConfig(
    feeVault: string,
    withdrawer: string,
    baseFee: bigint,
    platformFee: bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const inputs = [
      fieldLiteral(CONFIG_NAME),
      feeVault,
      withdrawer,
      `${baseFee}u64`,
      `${platformFee}u64`,
    ];
    return this.execute("initialize_config", inputs, fee);
  }

  /** Execute `update_config` (config admin only). */
  async updateConfig(
    feeVault: string,
    withdrawer: string,
    baseFee: bigint,
    platformFee: bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const inputs = [
      fieldLiteral(CONFIG_NAME),
      feeVault,
      withdrawer,
      `${baseFee}u64`,
      `${platformFee}u64`,
    ];
    return this.execute("update_config", inputs, fee);
  }

  /** Execute `set_token_whitelisted` (config admin only). */
  async setTokenWhitelisted(
    tokenProgram: string,
    allowed: boolean,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const inputs = [fieldLiteral(CONFIG_NAME), identLiteral(tokenProgram), `${allowed}`];
    return this.execute("set_token_whitelisted", inputs, fee);
  }

  // =======================================================================
  // Deployment
  // =======================================================================

  /** Deploy (or upgrade) the stream program through the wallet. */
  async deploy(program: string, fee: number = DEFAULT_FEE): Promise<string> {
    const deployment: AleoDeployment = {
      program,
      address: this.wallet.address,
      priorityFee: fee,
      privateFee: false,
    };
    const result = await this.wallet.executeDeployment(deployment);
    return result.transactionId;
  }

  // =======================================================================
  // Reads (mapping queries)
  // =======================================================================

  /**
   * The stream program's own on-chain address — what `std::ctx::addr()`
   * resolves to inside the program. Needed as the `spender` for
   * `approve_public` on the token program before `create_stream_public`'s
   * deposit transfer, and matches `self_address` in the cancel/withdraw
   * transitions.
   */
  getProgramAddress(): string {
    this.programAddress ??= Address.fromProgramId(PROGRAM_ID).toString();
    return this.programAddress;
  }

  /** Read and parse `stream_anchors[streamId]`. */
  async getStreamAnchor(streamId: string | bigint): Promise<StreamAnchor> {
    const value = await this.networkClient.getProgramMappingValue(
      PROGRAM_ID,
      "stream_anchors",
      fieldLiteral(streamId),
    );
    return parseStreamAnchor(value);
  }

  /** Read and parse `streams[streamId]` (public streams only). */
  async getStream(streamId: string | bigint): Promise<Stream> {
    const value = await this.networkClient.getProgramMappingValue(
      PROGRAM_ID,
      "streams",
      fieldLiteral(streamId),
    );
    return parseStream(value);
  }

  /** Read and parse `stream_config[configName]`. */
  async getStreamConfig(configName: string | bigint = CONFIG_NAME): Promise<StreamConfig> {
    const value = await this.networkClient.getProgramMappingValue(
      PROGRAM_ID,
      "stream_configs",
      fieldLiteral(configName),
    );
    return parseStreamConfig(value);
  }

  /**
   * Read `whitelisted_token_programs[whitelistKey(configName, token)]`.
   * Returns `false` when the key has never been set.
   */
  async isTokenWhitelisted(
    configName: string | bigint,
    tokenProgram: string,
  ): Promise<boolean> {
    try {
      const value = await this.networkClient.getProgramMappingValue(
        PROGRAM_ID,
        "whitelisted_token_programs",
        whitelistKey(configName, tokenProgram),
      );
      return parseBoolLiteral(value);
    } catch {
      return false;
    }
  }

  /**
   * Preview the withdrawable amounts of a stream at `now` by combining the
   * on-chain anchor with the off-chain vesting math. Mirrors the payout logic
   * of the withdraw transitions: vesting accrues against the stream's full
   * amount and the payout is capped at the funded remainder
   * (`deposited_amount - withdrawn_amount`).
   *
   * `fullAmount` — the stream's total (from the receiver/sender ticket for
   * private streams or the `streams` mapping for public ones). When omitted,
   * it is fetched from `streams` for public streams; for private streams it
   * falls back to `deposited_amount`, which understates accrued-but-unfunded
   * amounts on buffer-mode streams.
   */
  async getWithdrawableAmounts(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    fullAmount?: bigint,
  ): Promise<WithdrawableAmounts> {
    const anchor = await this.getStreamAnchor(streamId);
    const effectiveNow = anchor.paused ? anchor.lastPausedTime : now;
    let base = fullAmount;
    if (base === undefined) {
      if (anchor.isPublic) {
        base = (await this.getStream(streamId)).fullAmount;
      } else {
        // Private fallback without ticket access: cap at what is funded.
        base = anchor.depositedAmount;
      }
    }
    const { totalWithdrawable, currentlyWithdrawable } = computeWithdrawableAmount(
      effectiveNow,
      anchor.startTime,
      anchor.duration,
      anchor.pausedInterval,
      base,
      anchor.withdrawnAmount,
    );
    // Payout is capped at the funded remainder.
    const available = anchor.depositedAmount - anchor.withdrawnAmount;
    return {
      totalWithdrawable,
      currentlyWithdrawable:
        currentlyWithdrawable <= available ? currentlyWithdrawable : available,
    };
  }

  // =======================================================================
  // Record helpers (via the wallet)
  // =======================================================================

  /** Decrypt all unspent records of a program held by the wallet. */
  private async decryptProgramRecords(programId: string): Promise<string[]> {
    const records = await this.wallet.requestRecords(programId, false);
    const plaintexts: string[] = [];
    for (const record of records) {
      const envelope = record as {
        recordCiphertext?: string;
        ciphertext?: string;
        spent?: boolean;
      } | null;
      if (envelope == null || envelope.spent !== false) continue;
      const ciphertext = envelope.recordCiphertext ?? envelope.ciphertext;
      if (ciphertext === undefined) continue;
      const plaintext = await this.wallet.decrypt(ciphertext);
      // Collapse the multi-line record plaintext to a single line so the
      // regexes below and the transition input are well-formed.
      plaintexts.push(plaintext.replace(/\s+/g, " ").trim());
    }
    return plaintexts;
  }

  /** Find the highest-value unspent credits record covering `minMicrocredits`. */
  async findCredits(minMicrocredits: bigint): Promise<string> {
    const plaintexts = await this.decryptProgramRecords(CREDITS_PROGRAM_ID);
    let best: { text: string; amount: bigint } | undefined;
    for (const text of plaintexts) {
      const amount = recordAmount(text, "microcredits");
      if (
        amount !== undefined &&
        amount >= minMicrocredits &&
        (best === undefined || amount > best.amount)
      ) {
        best = { text, amount };
      }
    }
    if (best === undefined) {
      throw new Error(
        `no unspent credits.aleo record with at least ${minMicrocredits} microcredits`,
      );
    }
    return best.text;
  }

  /** Find the highest-value unspent token record covering `minAmount`. */
  async findToken(minAmount: bigint): Promise<string> {
    const plaintexts = await this.decryptProgramRecords(TOKEN_PROGRAM_ID);
    let best: { text: string; amount: bigint } | undefined;
    for (const text of plaintexts) {
      if (!text.includes("owner:")) continue;
      const amount = recordAmount(text, "amount");
      if (
        amount !== undefined &&
        amount >= minAmount &&
        (best === undefined || amount > best.amount)
      ) {
        best = { text, amount };
      }
    }
    if (best === undefined) {
      throw new Error(
        `no unspent token record in ${TOKEN_PROGRAM_ID} with at least ${minAmount}`,
      );
    }
    return best.text;
  }

  /** Find the unspent stream ticket record of `recordName` for `streamId`. */
  async findTicket(
    recordName: TicketRecordName,
    streamId: string | bigint,
  ): Promise<string> {
    const idDigits = streamId.toString().replace(/field$/, "");
    const plaintexts = await this.decryptProgramRecords(PROGRAM_ID);
    for (const text of plaintexts) {
      if (
        matchesTicket(text, recordName) &&
        new RegExp(`stream_id:\\s*${idDigits}field`).test(text)
      ) {
        return text;
      }
    }
    throw new Error(`no ${recordName} record found for stream ${idDigits}`);
  }

  /** Classify all unspent stream ticket records held by the wallet. */
  async listMyTickets(): Promise<TicketInfo[]> {
    const plaintexts = await this.decryptProgramRecords(PROGRAM_ID);
    const tickets: TicketInfo[] = [];
    for (const text of plaintexts) {
      const kind = classifyTicket(text);
      if (kind === undefined) continue;
      const match = /stream_id:\s*(\d+)field/.exec(text);
      if (match === null) continue;
      tickets.push({ kind, streamId: match[1]!, plaintext: text });
    }
    return tickets;
  }

  // =======================================================================
  // Stream listing
  // =======================================================================

  /**
   * List the wallet's private streams by scanning its unspent stream ticket
   * records — no on-chain index exists for private streams (by design:
   * sender/receiver never touch public state). Sender tickets (ticket_type 0)
   * are outgoing, receiver tickets (ticket_type 1) are incoming. Deduplicated
   * per (stream id, direction); canceled streams still appear here since the
   * sender ticket is burned on cancel — check the anchor's `canceled` flag.
   */
  async listMyPrivateStreams(): Promise<PrivateStreamRef[]> {
    const streams = new Map<string, PrivateStreamRef>();
    for (const ticket of await this.listMyTickets()) {
      let direction: "outgoing" | "incoming";
      if (ticket.kind === "SenderStreamTicket") direction = "outgoing";
      else if (ticket.kind === "ReceiverStreamTicket") direction = "incoming";
      else continue; // withdrawer tickets mirror existing streams
      const key = `${ticket.streamId}:${direction}`;
      if (!streams.has(key)) {
        streams.set(key, {
          streamId: ticket.streamId,
          direction,
          ticketKind: ticket.kind,
          ticketPlaintext: ticket.plaintext,
        });
      }
    }
    return [...streams.values()];
  }

  /**
   * List every public stream touching the wallet in both directions via the
   * on-chain per-address registries (`outgoing_stream_refs` /
   * `incoming_stream_refs`), hydrated with anchor and stream entries.
   * Includes canceled and ended streams — filter with
   * `anchor.canceled` / `anchor.withdrawnAmount >= stream.fullAmount`.
   */
  async listMyPublicStreams(): Promise<PublicStreamEntry[]> {
    const [outIds, inIds] = await Promise.all([
      this.listRegistryStreamIds("outgoing"),
      this.listRegistryStreamIds("incoming"),
    ]);
    const byId = new Map<string, PublicStreamEntry>();
    for (const streamId of outIds) {
      byId.set(streamId, { streamId, direction: "outgoing" });
    }
    for (const streamId of inIds) {
      const existing = byId.get(streamId);
      if (existing) existing.direction = "both";
      else byId.set(streamId, { streamId, direction: "incoming" });
    }
    const entries = [...byId.values()];
    await Promise.all(
      entries.map(async (entry) => {
        entry.anchor = await this.getStreamAnchor(entry.streamId).catch(() => undefined);
        entry.stream = await this.getStream(entry.streamId).catch(() => undefined);
      }),
    );
    return entries;
  }

  /**
   * Combined listing: public streams from the on-chain registries plus
   * private streams from wallet record scanning. Public entries carry their
   * anchor/stream; private entries carry the decrypted ticket plaintext.
   */
  async listMyStreams(): Promise<{
    publicStreams: PublicStreamEntry[];
    privateStreams: PrivateStreamRef[];
  }> {
    const [publicStreams, privateStreams] = await Promise.all([
      this.listMyPublicStreams(),
      this.listMyPrivateStreams(),
    ]);
    return { publicStreams, privateStreams };
  }

  /**
   * Read one registry (`outgoing` / `incoming`) for the wallet's address and
   * return all referenced stream ids in creation order.
   */
  private async listRegistryStreamIds(
    direction: "outgoing" | "incoming",
  ): Promise<string[]> {
    const account = this.wallet.address;
    let count = 0n;
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        PROGRAM_ID,
        `${direction}_stream_counts`,
        account,
      );
      if (raw) count = parseIntLiteral(raw);
    } catch {
      return [];
    }
    const ids: string[] = [];
    for (let i = 0n; i < count; i++) {
      const raw = await this.networkClient.getProgramMappingValue(
        PROGRAM_ID,
        `${direction}_stream_refs`,
        streamRefKey(account, i),
      );
      if (!raw) {
        throw new Error(`missing ${direction} stream ref for ${account} at index ${i}`);
      }
      ids.push(parseFieldLiteral(raw));
    }
    return ids;
  }

  // =======================================================================
  // Transaction confirmation
  // =======================================================================

  /**
   * Poll the wallet's `transactionStatus` until the transaction is accepted
   * or fails (~10 min timeout). Falls back to the network client when the
   * wallet's status method errors.
   */
  async waitForConfirmation(txId: string): Promise<void> {
    const deadline = Date.now() + TX_TIMEOUT_MS;
    let walletStatusBroken = false;
    while (Date.now() < deadline) {
      let status: string;
      try {
        status = (await this.wallet.transactionStatus(txId)).status;
      } catch {
        walletStatusBroken = true;
        break;
      }
      const s = status.toLowerCase();
      if (["accepted", "confirmed", "completed", "finalized"].includes(s)) return;
      if (["failed", "rejected", "aborted"].includes(s)) {
        throw new Error(`Transaction ${txId} failed with status: ${status}`);
      }
      await sleep(TX_POLL_MS);
    }
    if (!walletStatusBroken) {
      throw new Error(`timed out waiting for transaction ${txId}`);
    }
    const confirmation = await this.networkClient.waitForTransactionConfirmation(
      txId,
      TX_POLL_MS,
      TX_TIMEOUT_MS,
    );
    if (confirmation.status.toLowerCase() !== "accepted") {
      throw new Error(`Transaction ${txId} failed with status: ${confirmation.status}`);
    }
  }

  // =======================================================================
  // Internals
  // =======================================================================

  /** Read the on-chain stream config and shape it as the `Config` input. */
  async getConfigInput(): Promise<Config> {
    const chainConfig = await this.getStreamConfig(CONFIG_NAME);
    return {
      configName: CONFIG_NAME,
      admin: chainConfig.admin,
      feeVault: chainConfig.feeVault,
      withdrawer: chainConfig.withdrawer,
      baseFee: chainConfig.baseFee,
      platformFee: chainConfig.platformFee,
    };
  }

  /**
   * Build a Sealance Merkle exclusion proof showing the connected account is
   * NOT on the token program's freeze list. Returns the single
   * `[iarc22::MerkleProof; 2]` plaintext input.
   */
  private async getComplianceProofs(): Promise<string> {
    const res = await fetch(FREEZE_LIST_URL);
    if (!res.ok) {
      throw new Error(`failed to fetch freeze list: ${res.status} ${res.statusText}`);
    }
    const sealance = new SealanceMerkleTree();
    const tree = sealance.convertTreeToBigInt(await res.json());
    const [leftIdx, rightIdx] = sealance.getLeafIndices(tree, this.wallet.address);
    const leftProof = sealance.getSiblingPath(tree, leftIdx, 16);
    const rightProof = sealance.getSiblingPath(tree, rightIdx, 16);
    return sealance.formatMerkleProof([leftProof, rightProof]);
  }

  private async execute(
    functionName: string,
    inputs: string[],
    fee: number,
    imports?: string[],
  ): Promise<string> {
    const result = await this.wallet.executeTransaction({
      program: PROGRAM_ID,
      function: functionName,
      inputs,
      fee,
      privateFee: false,
      ...(imports !== undefined ? { imports } : {}),
    });
    if (result === undefined || result.transactionId === "") {
      throw new Error("wallet did not return a transaction id (rejected?)");
    }
    return result.transactionId;
  }
}

/**
 * `WalletPayrollService` — wallet-backed counterpart of the Node
 * `PayrollService` (sdk/client.ts). All transactions are executed by the
 * Shield wallet (`executeTransaction` / `executeDeployment`) and all records
 * come from the wallet (`requestRecords` + `decrypt`); mapping reads go
 * through an `AleoNetworkClient`, exactly as in the Node SDK.
 */

import { AleoNetworkClient, SealanceMerkleTree } from "@provablehq/sdk/testnet.js";
import type { TransactionStatusResponse } from "@provablehq/aleo-types";
import type { AleoDeployment } from "@provablehq/aleo-wallet-standard";

import { feeTierKey, whitelistKey } from "../../../sdk/hashing.ts";
import {
  computeStreamFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  MAX_FEE_TIERS,
  nowSeconds,
  type WithdrawableAmounts,
} from "../../../sdk/math.ts";
import {
  configToPlaintext,
  createStreamParamsToPlaintext,
  fieldLiteral,
  identLiteral,
  parseBoolLiteral,
  parseFeeTier,
  parsePayrollConfig,
  parseStreamAnchor,
  streamAnchorToPlaintext,
  tokenPriceToPlaintext,
} from "../../../sdk/plaintext.ts";
import { signTokenPrice } from "../../../sdk/signing.ts";
import type {
  Config,
  CreateStreamParams,
  FeeTier,
  PayrollConfig,
  StreamAnchor,
  TokenPrice,
} from "../../../sdk/types.ts";

import {
  ALEO_PRICE_USD,
  CONFIG_NAME,
  CREDITS_PROGRAM_ID,
  DEFAULT_FEE,
  DYNAMIC_DISPATCH_IMPORTS,
  FREEZE_LIST_URL,
  HOST,
  PROGRAM_ID,
  TOKEN_PROGRAM,
  TOKEN_PROGRAM_ID,
  TOKEN_PRICE_USD,
} from "../config.ts";

/** Subset of the `useWallet()` context the service needs. */
export interface PayrollWallet {
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
  | "SenderPayrollTicket"
  | "ReceiverPayrollTicket"
  | "WithdrawerPayrollTicket";

export interface TicketInfo {
  kind: TicketRecordName;
  /** Bare digits of the stream id (no `field` suffix). */
  streamId: string;
  plaintext: string;
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
 * Record plaintexts do not carry the record name, but every payroll ticket
 * carries a `ticket_type` member (ported from sdk/records.ts): 0 = sender,
 * 1 = receiver, 2 = withdrawer.
 */
const TICKET_KIND_BY_TYPE: Record<number, TicketRecordName> = {
  0: "SenderPayrollTicket",
  1: "ReceiverPayrollTicket",
  2: "WithdrawerPayrollTicket",
};

function classifyTicket(text: string): TicketRecordName | undefined {
  const match = /ticket_type:\s*(\d+)u8/.exec(text);
  if (match === null) return undefined;
  return TICKET_KIND_BY_TYPE[Number(match[1])];
}

function matchesTicket(text: string, recordName: TicketRecordName): boolean {
  return classifyTicket(text) === recordName;
}

export class WalletPayrollService {
  readonly wallet: PayrollWallet;
  readonly networkClient: AleoNetworkClient;

  constructor(wallet: PayrollWallet) {
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
   * scripts/payroll.ts:createStream — on-chain config read, fee tier
   * resolution, admin-signed TokenPrice, Sealance compliance proofs, and
   * credit/token record selection from the wallet.
   *
   * `adminKey` is the config admin's private key, used only to sign the
   * TokenPrice attestation (never stored).
   */
  async createStreamPrivate(
    params: CreateStreamParams,
    adminKey: string,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
    const config = await this.getConfigInput();
    const tokenPrice: TokenPrice = {
      config: CONFIG_NAME,
      streamToken: TOKEN_PROGRAM,
      streamTokenPriceUsd: TOKEN_PRICE_USD,
      aleoPriceUsd: ALEO_PRICE_USD,
      priceExpiry: nowSeconds() + 3600n,
      nonce: randomField(),
    };
    const priceSignature = signTokenPrice(adminKey, tokenPrice);
    // usdValue does not depend on feeBps; resolve the tier from it, then fee.
    const { usdValue } = computeStreamFee(
      params.amount,
      TOKEN_PRICE_USD,
      ALEO_PRICE_USD,
      0n,
    );
    const feeBps = await this.resolveFeeBps(usdValue);
    const { streamFee } = computeStreamFee(
      params.amount,
      TOKEN_PRICE_USD,
      ALEO_PRICE_USD,
      feeBps,
    );
    // The credit record must cover the auto-withdrawal fee plus the stream
    // fee (see the splits in `create_stream_private`).
    let autoWithdrawalFee = 0n;
    if (params.autoWithdrawable) {
      autoWithdrawalFee =
        config.platformFee + (params.duration / params.withdrawFrequency) * config.baseFee;
    }
    console.log("auto-withdrawal fee:", autoWithdrawalFee, "stream fee:", streamFee);
    const creditRecord = await this.findCredits(autoWithdrawalFee + streamFee);
    console.log("credit record:", creditRecord);
    const tokenRecord = await this.findToken(depositAmount);
    console.log("token record:", tokenRecord);
    const merkleProofs = await this.getComplianceProofs();
    console.log("merkle proofs:", merkleProofs);
    const inputs = [
      createStreamParamsToPlaintext(params),
      identLiteral(TOKEN_PROGRAM),
      configToPlaintext(config),
      tokenPriceToPlaintext(tokenPrice),
      priceSignature,
      `${feeBps}u64`,
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
    const ticket = await this.findTicket("SenderPayrollTicket", streamId);
    return this.execute("pause_resume_stream_private", [ticket], fee);
  }

  /** Execute `cancel_private`. */
  async cancelStream(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const ticket = await this.findTicket("SenderPayrollTicket", streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticket, streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
    return this.execute("cancel_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
  }

  /** Execute `withdraw_private`. */
  async withdraw(
    streamId: string | bigint,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const ticket = await this.findTicket("ReceiverPayrollTicket", streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticket, streamAnchorToPlaintext(anchor), `${nowSeconds()}i64`];
    return this.execute("withdraw_private", inputs, fee, DYNAMIC_DISPATCH_IMPORTS);
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
    const ticket = await this.findTicket("SenderPayrollTicket", streamId);
    const anchor = await this.getStreamAnchor(streamId);
    const fullAmount = recordAmount(ticket, "full_amount");
    if (fullAmount === undefined) {
      throw new Error("could not parse full_amount from the ticket record");
    }
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

  /** Execute `set_fee_tier` (config admin only). */
  async setFeeTier(
    index: number,
    tier: FeeTier,
    fee: number = DEFAULT_FEE,
  ): Promise<string> {
    const inputs = [
      fieldLiteral(CONFIG_NAME),
      `${index}u8`,
      `${tier.minAmount}u64`,
      `${tier.maxAmount}u64`,
      `${tier.feeBps}u64`,
    ];
    return this.execute("set_fee_tier", inputs, fee);
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

  /** Deploy (or upgrade) the payroll program through the wallet. */
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

  /** Read and parse `stream_anchors[streamId]`. */
  async getStreamAnchor(streamId: string | bigint): Promise<StreamAnchor> {
    const value = await this.networkClient.getProgramMappingValue(
      PROGRAM_ID,
      "stream_anchors",
      fieldLiteral(streamId),
    );
    return parseStreamAnchor(value);
  }

  /** Read and parse `payroll_config[configName]`. */
  async getPayrollConfig(configName: string | bigint = CONFIG_NAME): Promise<PayrollConfig> {
    const value = await this.networkClient.getProgramMappingValue(
      PROGRAM_ID,
      "payroll_configs",
      fieldLiteral(configName),
    );
    return parsePayrollConfig(value);
  }

  /** Read and parse `fee_tiers[feeTierKey(configName, index)]`. */
  async getFeeTier(configName: string | bigint, index: number): Promise<FeeTier> {
    const value = await this.networkClient.getProgramMappingValue(
      PROGRAM_ID,
      "fee_tiers",
      feeTierKey(configName, index),
    );
    if (!value) {
      throw new Error(`fee tier not found for config ${configName} at index ${index}`);
    }
    return parseFeeTier(value);
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
   * on-chain anchor with the off-chain vesting math.
   */
  async getWithdrawableAmounts(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
  ): Promise<WithdrawableAmounts> {
    const anchor = await this.getStreamAnchor(streamId);
    const effectiveNow = anchor.paused ? anchor.lastPausedTime : now;
    return computeWithdrawableAmount(
      effectiveNow,
      anchor.startTime,
      anchor.duration,
      anchor.pausedInterval,
      anchor.depositedAmount,
      anchor.withdrawnAmount,
    );
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

  /** Find the unspent payroll ticket record of `recordName` for `streamId`. */
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

  /** Classify all unspent payroll ticket records held by the wallet. */
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

  /** Read the on-chain payroll config and shape it as the `Config` input. */
  private async getConfigInput(): Promise<Config> {
    const chainConfig = await this.getPayrollConfig(CONFIG_NAME);
    return {
      configName: CONFIG_NAME,
      admin: chainConfig.admin,
      feeVault: chainConfig.feeVault,
      withdrawer: chainConfig.withdrawer,
      baseFee: chainConfig.baseFee,
      platformFee: chainConfig.platformFee,
    };
  }

  /** Find the on-chain fee tier matching the stream's USD value. */
  private async resolveFeeBps(usdValue: bigint): Promise<bigint> {
    for (let index = 0; index < MAX_FEE_TIERS; index++) {
      let tier: FeeTier;
      try {
        tier = await this.getFeeTier(CONFIG_NAME, index);
      } catch {
        break; // no more tiers set
      }
      if (usdValue > tier.minAmount && usdValue <= tier.maxAmount) {
        return tier.feeBps;
      }
    }
    throw new Error(`no fee tier covers stream USD value ${usdValue}`);
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

/**
 * `StreamClient` — high-level interface to the `test_zebec_stream_v1.aleo` program:
 * stream lifecycle operations, admin configuration, and mapping reads.
 */

import {
  Account,
  AleoKeyProvider,
  AleoNetworkClient,
  ProgramManager,
  type RecordPlaintext,
} from "@provablehq/sdk/testnet.js";

import { streamRefKey, tokenAllowanceKey, whitelistKey } from "./hashing.js";
import {
  computeAutoWithdrawalFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  nowSeconds,
  SPLIT_FEE,
} from "./math.js";
import {
  configToPlaintext,
  createStreamParamsToPlaintext,
  fieldLiteral,
  identLiteral,
  merkleProofsToPlaintext,
  parseBoolLiteral,
  parseFieldLiteral,
  parseIntLiteral,
  parseStream,
  parseStreamConfig,
  parseReceiverTicket,
  parseSenderTicket,
  parseStreamAnchor,
  parseWithdrawerTicket,
  streamToPlaintext,
  streamAnchorToPlaintext,
  streamTokenFeeToPlaintext,
} from "./plaintext.js";
import { findCreditsRecord, findTicketRecord, findTokenRecord } from "./records.js";
import type {
  Config,
  CreateStreamParams,
  ExecuteOptions,
  ListedStream,
  MerkleProof,
  Stream,
  StreamClientOptions as StreamServiceOptions,
  StreamConfig,
  StreamAnchor,
  StreamTokenFee,
} from "./types.js";
import type { WithdrawableAmounts } from "./math.js";
import type { TicketRecordName } from "./records.js";

export const DEFAULT_ENDPOINT = "https://api.explorer.provable.com/v1";
export const PROGRAM_ID = "test_zebec_stream_v1.aleo";

export class StreamService {
  readonly programId: string;
  readonly networkClient: AleoNetworkClient;
  readonly programManager: ProgramManager;
  readonly account?: Account;

  private readonly privateKey?: string;
  private readonly programSource?: string;
  private readonly programImports?: Record<string, string>;
  private readonly proverUri?: string;
  private readonly proverApiKey?: string;
  private readonly proverConsumerId?: string;
  private readonly programSourceCache = new Map<string, string>();

  constructor(options: StreamServiceOptions = {}) {
    const host = options.host ?? DEFAULT_ENDPOINT;
    this.programId = options.programId ?? PROGRAM_ID;
    this.networkClient = new AleoNetworkClient(host);
    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    this.programManager = new ProgramManager(host, keyProvider);
    if (options.privateKey !== undefined) {
      this.privateKey = options.privateKey;
      this.account = new Account({ privateKey: options.privateKey });
      this.programManager.setAccount(this.account);
    }
    if (options.programSource !== undefined) {
      this.programSource = options.programSource;
    }
    if (options.programImports !== undefined) {
      this.programImports = options.programImports;
    }
    if (options.proverUri !== undefined) {
      this.proverUri = options.proverUri;
      this.networkClient.setProverUri(options.proverUri);
    }
    if (options.proverApiKey !== undefined) {
      this.proverApiKey = options.proverApiKey;
    }
    if (options.proverConsumerId !== undefined) {
      this.proverConsumerId = options.proverConsumerId;
    }
  }

  // =======================================================================
  // User: stream lifecycle
  // =======================================================================

  /**
   * Execute `create_stream_private`.
   *
   * `tokenProgram` is the bare identifier of the IARC22 token program (e.g.
   * `"my_token"` — without the `.aleo` suffix). `creditRecord` / `tokenRecord`
   * are located automatically when omitted (requires a `privateKey`).
   *
   * The credit record must cover: auto-withdrawal fee + stream fee +
   * 10,000 microcredits (the `credits.aleo::split` protocol burn).
   */
  async createStreamPrivate(
    params: CreateStreamParams,
    tokenProgram: string,
    config: Config,
    tokenFee: StreamTokenFee,
    feeSignature: string,
    merkleProofs: [MerkleProof, MerkleProof],
    options: ExecuteOptions & {
      creditRecord?: string | RecordPlaintext;
      tokenRecord?: string | RecordPlaintext;
    } = {},
  ): Promise<string> {
    const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
    const streamFee = tokenFee.streamFeeAmount;
    // Exact mirror of the on-chain fee math (multiply before divide); a
    // lower estimate would make the credit-record coverage assert fail.
    const autoWithdrawalFee = params.autoWithdrawable
      ? computeAutoWithdrawalFee(
          params.duration,
          params.withdrawFrequency,
          config.baseFee,
          config.platformFee,
        )
      : 0n;
    const creditRecord =
      options.creditRecord !== undefined
        ? options.creditRecord.toString()
        : await this.findCredits(autoWithdrawalFee + streamFee + SPLIT_FEE);
    console.debug(
      `Found credit record covering auto-withdrawal fee ${autoWithdrawalFee}, stream fee ${streamFee}, split burn ${SPLIT_FEE}`,
    );
    const tokenRecord =
      options.tokenRecord !== undefined
        ? options.tokenRecord.toString()
        : await this.findToken(`${tokenProgram}.aleo`, depositAmount);
    console.debug(`Found token record covering deposit amount ${depositAmount}`);
    const tokenProgramId = `${tokenProgram}.aleo`;
    const inputs = [
      createStreamParamsToPlaintext(params),
      identLiteral(tokenProgram),
      configToPlaintext(config),
      streamTokenFeeToPlaintext(tokenFee),
      feeSignature,
      creditRecord,
      tokenRecord,
      merkleProofsToPlaintext(merkleProofs),
    ];
    const extraImports = {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    };
    return this.execute("create_stream_private", inputs, options, extraImports);
  }

  /**
   * Execute `pause_resume_stream_private` (toggles pause/resume). The sender
   * ticket record is located automatically when omitted.
   */
  async pauseResumeStream(
    streamId: string | bigint,
    ticket?: string | RecordPlaintext,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const ticketRecord = ticket?.toString() ?? (await this.findTicket("SenderStreamTicket", streamId));
    return this.execute("pause_resume_stream_private", [ticketRecord], options);
  }

  /**
   * Execute `cancel_stream_private`. The sender ticket record and the on-chain
   * stream anchor are resolved automatically when omitted.
   */
  async cancelStream(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    ticket?: string | RecordPlaintext,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const ticketRecord = ticket?.toString() ?? (await this.findTicket("SenderStreamTicket", streamId));
    const senderTicket = parseSenderTicket(ticketRecord);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticketRecord, streamAnchorToPlaintext(anchor), `${now}i64`];
    return this.execute("cancel_stream_private", inputs, options, await this.ticketTokenImport(senderTicket.tokenProgram));
  }

  /**
   * Execute `withdraw_stream_private`. The receiver ticket record and the on-chain
   * stream anchor are resolved automatically when omitted.
   */
  async withdraw(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    ticket?: string | RecordPlaintext,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const ticketRecord = ticket?.toString() ?? (await this.findTicket("ReceiverStreamTicket", streamId));
    const receiverTicket = parseReceiverTicket(ticketRecord);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticketRecord, streamAnchorToPlaintext(anchor), `${now}i64`];
    return this.execute("withdraw_stream_private", inputs, options, await this.ticketTokenImport(receiverTicket.tokenProgram));
  }

  /**
   * Execute `withdraw_stream_auto_private`: pay out the receiver's accrued
   * amount on behalf of the receiver. Withdrawer only — the withdrawer ticket
   * record and the on-chain anchor are resolved automatically when omitted.
   */
  async withdrawAuto(
    streamId: string | bigint,
    config: Config,
    now: bigint = nowSeconds(),
    ticket?: string | RecordPlaintext,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const ticketRecord =
      ticket?.toString() ?? (await this.findTicket("WithdrawerStreamTicket", streamId));
    const withdrawerTicket = parseWithdrawerTicket(ticketRecord);
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      ticketRecord,
      configToPlaintext(config),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    const tokenProgramId = `${withdrawerTicket.tokenProgram}.aleo`;
    return this.execute("withdraw_stream_auto_private", inputs, options, {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    });
  }

  /**
   * Execute `topup_stream_private`: pay the accrued debt of a buffer-mode
   * stream plus `extra` pre-paid coverage. Sender only — the sender ticket
   * record, on-chain anchor, and a covering token record are resolved
   * automatically when omitted. No ALEO fee is charged on top-ups.
   */
  async topupStream(
    streamId: string | bigint,
    extra: bigint,
    merkleProofs: [MerkleProof, MerkleProof],
    now: bigint = nowSeconds(),
    options: ExecuteOptions & {
      ticket?: string | RecordPlaintext;
      tokenRecord?: string | RecordPlaintext;
    } = {},
  ): Promise<string> {
    const ticketRecord =
      options.ticket?.toString() ?? (await this.findTicket("SenderStreamTicket", streamId));
    const senderTicket = parseSenderTicket(ticketRecord);
    const anchor = await this.getStreamAnchor(streamId);
    const tokenProgramId = `${senderTicket.tokenProgram}.aleo`;
    const { topupAmount } = computeTopupAmount(anchor, senderTicket.fullAmount, now, extra);
    const tokenRecord =
      options.tokenRecord?.toString() ?? (await this.findToken(tokenProgramId, topupAmount));
    const inputs = [
      ticketRecord,
      streamAnchorToPlaintext(anchor),
      `${extra}u128`,
      `${now}i64`,
      tokenRecord,
      merkleProofsToPlaintext(merkleProofs),
    ];
    return this.execute("topup_stream_private", inputs, options, {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    });
  }

  /**
   * Execute `create_stream_public`. Unlike the private variant, the token
   * deposit is pulled from the signer's public balance (the program calls
   * `IARC22::transfer_from_public`), so no credit/token records are needed —
   * the employer must have approved this program on the token and hold enough
   * public credits for the fees. `merkleProofs` is not required either.
   */
  async createStreamPublic(
    params: CreateStreamParams,
    tokenProgram: string,
    config: Config,
    tokenFee: StreamTokenFee,
    feeSignature: string,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const tokenProgramId = `${tokenProgram}.aleo`;
    const inputs = [
      createStreamParamsToPlaintext(params),
      identLiteral(tokenProgram),
      configToPlaintext(config),
      streamTokenFeeToPlaintext(tokenFee),
      feeSignature,
    ];
    const extraImports = {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    };
    return this.execute("create_stream_public", inputs, options, extraImports);
  }

  /**
   * Execute `pause_resume_stream_public` (toggles pause/resume). The signer
   * must be the stream's sender; only the stream id is needed as input.
   */
  async pauseResumeStreamPublic(
    streamId: string | bigint,
    options: ExecuteOptions = {},
  ): Promise<string> {
    return this.execute("pause_resume_stream_public", [fieldLiteral(streamId)], options);
  }

  /**
   * Execute `cancel_stream_public`. The stream (`streams` mapping) and the
   * on-chain anchor are resolved automatically when omitted. The signer must
   * be the stream's sender.
   */
  async cancelStreamPublic(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    stream?: Stream,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const streamValue = stream ?? (await this.getStream(streamId));
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      streamToPlaintext(streamValue),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    const tokenProgramId = `${streamValue.tokenProgram}.aleo`;
    return this.execute("cancel_stream_public", inputs, options, {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    });
  }

  /**
   * Execute `withdraw_stream_public`. The stream (`streams` mapping) and the
   * on-chain anchor are resolved automatically when omitted. The signer must
   * be the stream's receiver.
   */
  async withdrawPublic(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    stream?: Stream,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const streamValue = stream ?? (await this.getStream(streamId));
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      streamToPlaintext(streamValue),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    const tokenProgramId = `${streamValue.tokenProgram}.aleo`;
    return this.execute("withdraw_stream_public", inputs, options, {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    });
  }

  /**
   * Execute `topup_stream_public`: pay the accrued debt of a buffer-mode
   * public stream plus `extra` pre-paid coverage. The signer must be the
   * stream's sender and must have approved this program on the token (the
   * deposit is pulled from the signer's public balance via
   * `IARC22::transfer_from_public`). The stream and on-chain anchor are
   * resolved automatically when omitted.
   */
  async topupStreamPublic(
    streamId: string | bigint,
    extra: bigint,
    now: bigint = nowSeconds(),
    stream?: Stream,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const streamValue = stream ?? (await this.getStream(streamId));
    const anchor = await this.getStreamAnchor(streamId);
    // Fail fast when there is nothing to pay: the on-chain entry asserts
    // `debt_amount + extra > 0` with the same pause-aware debt math.
    const { topupAmount } = computeTopupAmount(anchor, streamValue.fullAmount, now, extra);
    if (topupAmount <= 0n) {
      throw new Error("top-up amount is zero: no accrued debt and no extra pre-payment");
    }
    const inputs = [
      streamToPlaintext(streamValue),
      streamAnchorToPlaintext(anchor),
      `${extra}u128`,
      `${now}i64`,
    ];
    const tokenProgramId = `${streamValue.tokenProgram}.aleo`;
    return this.execute("topup_stream_public", inputs, options, {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    });
  }

  /**
   * Execute `withdraw_stream_auto_public`: pay out the receiver's accrued
   * amount on behalf of the receiver. Withdrawer only — the signer must be
   * the config's withdrawer. The stream and on-chain anchor are resolved
   * automatically when omitted.
   */
  async withdrawAutoPublic(
    streamId: string | bigint,
    config: Config,
    now: bigint = nowSeconds(),
    stream?: Stream,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const streamValue = stream ?? (await this.getStream(streamId));
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [
      streamToPlaintext(streamValue),
      configToPlaintext(config),
      streamAnchorToPlaintext(anchor),
      `${now}i64`,
    ];
    const tokenProgramId = `${streamValue.tokenProgram}.aleo`;
    return this.execute("withdraw_stream_auto_public", inputs, options, {
      [tokenProgramId]: await this.loadProgramSource(tokenProgramId),
    });
  }

  // =======================================================================
  // Admin: configuration management
  // =======================================================================

  /** Execute `initialize_config` (one-time, caller becomes config admin). */
  async initializeConfig(
    configName: string | bigint,
    feeVault: string,
    withdrawer: string,
    baseFee: bigint,
    platformFee: bigint,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const inputs = [
      fieldLiteral(configName),
      feeVault,
      withdrawer,
      `${baseFee}u64`,
      `${platformFee}u64`,
    ];
    return this.execute("initialize_config", inputs, options);
  }

  /** Execute `update_config` (config admin only). */
  async updateConfig(
    configName: string | bigint,
    feeVault: string,
    withdrawer: string,
    baseFee: bigint,
    platformFee: bigint,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const inputs = [
      fieldLiteral(configName),
      feeVault,
      withdrawer,
      `${baseFee}u64`,
      `${platformFee}u64`,
    ];
    return this.execute("update_config", inputs, options);
  }

  /** Execute `set_token_whitelisted` (config admin only). */
  async setTokenWhitelisted(
    configName: string | bigint,
    tokenProgram: string,
    allowed: boolean,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const inputs = [fieldLiteral(configName), identLiteral(tokenProgram), `${allowed}`];
    return this.execute("set_token_whitelisted", inputs, options);
  }

  // =======================================================================
  // Reads (mapping queries)
  // =======================================================================
  /** Read and parse `stream_anchors[streamId]`. */
  async getStreamAnchor(streamId: string | bigint): Promise<StreamAnchor> {
    const value = await this.networkClient.getProgramMappingValue(
      this.programId,
      "stream_anchors",
      fieldLiteral(streamId),
    );

    if (!value) {
      throw new Error(`Could not fetch stream anchor for stream Id: ${streamId}`)
    }

    return parseStreamAnchor(value);
  }

  /** Read and parse `streams[streamId]` (public streams only). */
  async getStream(streamId: string | bigint): Promise<Stream> {
    const value = await this.networkClient.getProgramMappingValue(
      this.programId,
      "streams",
      fieldLiteral(streamId),
    );

    if (!value) {
      throw new Error(`Could not fetch stream for stream Id: ${streamId}`)
    }

    return parseStream(value);
  }

  /** Read and parse `stream_config[configName]`. */
  async getStreamConfig(configName: string | bigint): Promise<StreamConfig> {
    const value = await this.networkClient.getProgramMappingValue(
      this.programId,
      "stream_configs",
      fieldLiteral(configName),
    );

    if (!value) {
      throw new Error(`Could not fetch stream config for config name: ${configName}`)
    }

    return parseStreamConfig(value);
  }

  /**
   * Read `whitelisted_token_programs[whitelistKey(configName, token)]`.
   * Returns `false` when the key has never been set (mirroring the on-chain
   * `get_or_use(..., false)`).
   */
  async isTokenWhitelisted(
    configName: string | bigint,
    tokenProgram: string,
  ): Promise<boolean> {
    try {
      const value = await this.networkClient.getProgramMappingValue(
        this.programId,
        "whitelisted_token_programs",
        whitelistKey(configName, tokenProgram),
      );

      if (!value) {
        console.warn(`Could not find token whitelisted for config: ${configName} and token program: ${tokenProgram}. Using default value.`)
        return false;
      }

      return parseBoolLiteral(value);
    } catch {
      return false;
    }
  }

  /**
   * Preview the withdrawable amounts of a stream at `now` by combining the
   * on-chain anchor with the off-chain vesting math. Mirrors the payout logic
   * of `withdraw_stream_private` / `withdraw_stream_public`: vesting accrues
   * against the stream's full amount and the payout is capped at the funded
   * remainder (`deposited_amount - withdrawn_amount`).
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
  // Reads (per-address public stream registries)
  // =======================================================================

  /**
   * Number of public streams ever created by `account`, from the
   * `outgoing_stream_counts` mapping. Returns `0n` when unset.
   */
  async getOutgoingStreamCount(account: string): Promise<bigint> {
    return this.getRegistryCount("outgoing_stream_counts", account);
  }

  /**
   * Number of public streams ever received by `account`, from the
   * `incoming_stream_counts` mapping. Returns `0n` when unset.
   */
  async getIncomingStreamCount(account: string): Promise<bigint> {
    return this.getRegistryCount("incoming_stream_counts", account);
  }

  /**
   * The stream id at slot `index` of `account`'s outgoing registry
   * (`outgoing_stream_refs`), or `undefined` when the slot is absent.
   */
  async getOutgoingStreamRef(
    account: string,
    index: bigint | number,
  ): Promise<string | undefined> {
    return this.getRegistryRef("outgoing_stream_refs", account, index);
  }

  /**
   * The stream id at slot `index` of `account`'s incoming registry
   * (`incoming_stream_refs`), or `undefined` when the slot is absent.
   */
  async getIncomingStreamRef(
    account: string,
    index: bigint | number,
  ): Promise<string | undefined> {
    return this.getRegistryRef("incoming_stream_refs", account, index);
  }

  /**
   * List all public stream ids ever created by `account` (outgoing registry,
   * in creation order). Includes canceled and ended streams — filter via
   * {@link StreamService.getStreamAnchor}.
   */
  async listOutgoingStreamIds(account: string): Promise<string[]> {
    const count = await this.getOutgoingStreamCount(account);
    const ids: string[] = [];
    for (let i = 0n; i < count; i++) {
      const ref = await this.getOutgoingStreamRef(account, i);
      if (ref === undefined) {
        throw new Error(`missing outgoing stream ref for ${account} at index ${i}`);
      }
      ids.push(ref);
    }
    return ids;
  }

  /**
   * List all public stream ids ever received by `account` (incoming registry,
   * in creation order). Includes canceled and ended streams.
   */
  async listIncomingStreamIds(account: string): Promise<string[]> {
    const count = await this.getIncomingStreamCount(account);
    const ids: string[] = [];
    for (let i = 0n; i < count; i++) {
      const ref = await this.getIncomingStreamRef(account, i);
      if (ref === undefined) {
        throw new Error(`missing incoming stream ref for ${account} at index ${i}`);
      }
      ids.push(ref);
    }
    return ids;
  }

  /**
   * List every public stream touching `account` in both directions, hydrated
   * with its anchor and (public) stream entry. A stream where `account` is
   * both sender and receiver appears once with `direction: "both"`. Canceled
   * and ended streams are included; use `anchor.canceled` /
   * `anchor.withdrawnAmount >= stream.fullAmount` to filter.
   */
  async listPublicStreams(account: string): Promise<ListedStream[]> {
    const [outIds, inIds] = await Promise.all([
      this.listOutgoingStreamIds(account),
      this.listIncomingStreamIds(account),
    ]);
    const byId = new Map<string, ListedStream>();
    for (const id of outIds) {
      byId.set(id, { streamId: id, direction: "outgoing" });
    }
    for (const id of inIds) {
      const existing = byId.get(id);
      if (existing) {
        existing.direction = "both";
      } else {
        byId.set(id, { streamId: id, direction: "incoming" });
      }
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

  private async getRegistryCount(mappingName: string, account: string): Promise<bigint> {
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.programId,
        mappingName,
        account,
      );
      if (!raw) return 0n;
      return parseIntLiteral(raw);
    } catch {
      return 0n;
    }
  }

  private async getRegistryRef(
    mappingName: string,
    account: string,
    index: bigint | number,
  ): Promise<string | undefined> {
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.programId,
        mappingName,
        streamRefKey(account, index),
      );
      if (!raw) return undefined;
      return parseFieldLiteral(raw);
    } catch {
      return undefined;
    }
  }

  // =======================================================================
  // Record helpers
  // =======================================================================

  /** Find an unspent credits record of the client's account. */
  async findCredits(minMicrocredits: bigint): Promise<string> {
    const record = await findCreditsRecord(
      this.networkClient,
      this.requirePrivateKey(),
      minMicrocredits,
    );
    return record.toString();
  }

  /** Find an unspent token record of the client's account. */
  async findToken(tokenProgramId: string, minAmount: bigint): Promise<string> {
    const record = await findTokenRecord(
      this.networkClient,
      this.requirePrivateKey(),
      tokenProgramId,
      minAmount,
    );
    return record.toString();
  }

  /** Find a stream ticket record of the client's account. */
  async findTicket(recordName: TicketRecordName, streamId: string | bigint): Promise<string> {
    const record = await findTicketRecord(
      this.networkClient,
      this.requirePrivateKey(),
      this.programId,
      recordName,
      streamId,
    );
    return record.toString();
  }

  // =======================================================================
  // Internals
  // =======================================================================

  private async execute(
    functionName: string,
    inputs: string[],
    options: ExecuteOptions,
    extraImports?: Record<string, string>,
  ): Promise<string> {
    console.log("inputs", inputs);
    if (this.account === undefined) {
      throw new Error("StreamClient was constructed without a privateKey");
    }
    // Dynamic call targets (e.g. the IARC22 token program) are not static
    // imports of the stream program, so their sources must be supplied
    // explicitly for the snarkVM process to contain their stacks.
    const imports = { ...this.programImports, ...extraImports };
    if (this.proverUri !== undefined) {
      return this.executeDelegated(functionName, inputs, options, imports);
    }
    const keySearchParams = { cacheKey: `${this.programId}:${functionName}` };
    return this.programManager.execute({
      programName: this.programId,
      functionName,
      priorityFee: options.priorityFee ?? 0,
      privateFee: options.privateFee ?? false,
      inputs,
      ...(this.programSource !== undefined ? { program: this.programSource } : {}),
      ...(Object.keys(imports).length > 0 ? { imports } : {}),
      ...(options.feeRecord !== undefined ? { feeRecord: options.feeRecord } : {}),
      keySearchParams
    });
  }

  /**
   * Execute via a delegated proving service: build a `ProvingRequest` locally
   * (authorization only, no key synthesis or proof generation) and let the
   * remote prover produce the proofs and broadcast the transaction. Returns
   * the broadcast transaction id.
   */
  private async executeDelegated(
    functionName: string,
    inputs: string[],
    options: ExecuteOptions,
    imports: Record<string, string>,
  ): Promise<string> {
    const provingRequest = await this.programManager.provingRequest({
      programName: this.programId,
      functionName,
      priorityFee: options.priorityFee ?? 0,
      privateFee: options.privateFee ?? false,
      inputs,
      broadcast: true,
      unchecked: false,
      ...(this.programSource !== undefined ? { programSource: this.programSource } : {}),
      ...(Object.keys(imports).length > 0 ? { programImports: imports } : {}),
      ...(options.feeRecord !== undefined ? { feeRecord: options.feeRecord } : {}),
    });

    console.log("prover url", this.networkClient.proverUri);
    const response = await this.networkClient.submitProvingRequest({
      provingRequest,
      ...(this.proverApiKey !== undefined ? { apiKey: this.proverApiKey } : {}),
      ...(this.proverConsumerId !== undefined ? { consumerId: this.proverConsumerId } : {}),
    });

    const broadcast = response.broadcast_result;
    if (broadcast.status.toLowerCase() !== "accepted") {
      const detail = "message" in broadcast ? broadcast.message : undefined;
      throw new Error(
        `proving service failed to broadcast the transaction (status: ${broadcast.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return response.transaction.id;

  }

  /**
   * Load the source of a deployed program, preferring caller-provided
   * `programImports` and caching network fetches. Needed for programs that
   * are only reached through dynamic calls (the IARC22 token program).
   */
  private async loadProgramSource(programId: string): Promise<string> {
    const provided = this.programImports?.[programId];
    if (provided !== undefined) return provided;
    const cached = this.programSourceCache.get(programId);
    if (cached !== undefined) return cached;
    const source = await this.networkClient.getProgram(programId);
    this.programSourceCache.set(programId, source);
    return source;
  }

  /**
   * Load the source of the IARC22 token program identified by `tokenProgram`
   * (a bare identifier), as required for the dynamic token calls of
   * `withdraw_stream_private` and `cancel_stream_private`.
   */
  private async ticketTokenImport(tokenProgram: string): Promise<Record<string, string>> {
    const programId = `${tokenProgram}.aleo`;
    return { [programId]: await this.loadProgramSource(programId) };
  }

  private requirePrivateKey(): string {
    if (this.privateKey === undefined) {
      throw new Error("StreamClient was constructed without a privateKey");
    }
    return this.privateKey;
  }
}

// ===========================================================================
// Arc22Service — IARC22 token program client (approve / unapprove / views)
// ===========================================================================

export interface Arc22ServiceOptions {
  /** Bare IARC22 token-program identifier, e.g. `"test_usdcx_stablecoin"` (no `.aleo`). */
  tokenProgram: string;
  host?: string;
  privateKey?: string;
  /** Compiled source of the token program; required for local proving and offline view reads. */
  programSource?: string;
  programImports?: Record<string, string>;
  proverUri?: string;
  proverApiKey?: string;
  proverConsumerId?: string;
}

/**
 * High-level interface to an IARC22 token program (e.g.
 * `test_usdcx_stablecoin.aleo`). Exposes `approve` / `unapprove` (the
 * on-chain entry points needed to fund stream streams) plus direct mapping
 * reads (`getAllowance`, `getBalanceOf`).
 */
export class Arc22Service {
  readonly tokenProgram: string;
  readonly programId: string;
  readonly networkClient: AleoNetworkClient;
  readonly programManager: ProgramManager;
  readonly account?: Account;

  private readonly programSource?: string;
  private readonly programImports?: Record<string, string>;
  private readonly proverUri?: string;
  private readonly proverApiKey?: string;
  private readonly proverConsumerId?: string;

  constructor(options: Arc22ServiceOptions) {
    if (!options.tokenProgram) {
      throw new Error("Arc22Service requires a tokenProgram identifier");
    }
    const host = options.host ?? DEFAULT_ENDPOINT;
    this.tokenProgram = options.tokenProgram;
    this.programId = `${options.tokenProgram}.aleo`;
    this.networkClient = new AleoNetworkClient(host);
    const keyProvider = new AleoKeyProvider();
    keyProvider.useCache(true);
    this.programManager = new ProgramManager(host, keyProvider);
    if (options.privateKey !== undefined) {
      this.account = new Account({ privateKey: options.privateKey });
      this.programManager.setAccount(this.account);
    }
    if (options.programSource !== undefined) {
      this.programSource = options.programSource;
    }
    if (options.programImports !== undefined) {
      this.programImports = options.programImports;
    }
    if (options.proverUri !== undefined) {
      this.proverUri = options.proverUri;
      this.networkClient.setProverUri(options.proverUri);
    }
    if (options.proverApiKey !== undefined) {
      this.proverApiKey = options.proverApiKey;
    }
    if (options.proverConsumerId !== undefined) {
      this.proverConsumerId = options.proverConsumerId;
    }
  }

  // =========================================================================
  // Mutating entry points
  // =========================================================================

  /** Approve `spender` to spend `amount` (u128) of the caller's tokens. */
  async approve(
    spender: string,
    amount: bigint,
    options: ExecuteOptions = {},
  ): Promise<string> {
    return this.execute("approve_public", [spender, `${amount}u128`], options);
  }

  /** Revoke `amount` (u128) of an existing allowance granted to `spender`. */
  async unapprove(
    spender: string,
    amount: bigint,
    options: ExecuteOptions = {},
  ): Promise<string> {
    return this.execute("unapprove_public", [spender, `${amount}u128`], options);
  }

  // =========================================================================
  // Mapping reads (direct chain queries, no offline program execution)
  // =========================================================================

  /**
   * On-chain `allowance(owner, spender) -> u128`, read from the IARC22
   * `allowances` mapping. The mapping key is `hash.bhp256(TokenAllowance {
   * account: owner, spender })`. Returns `0n` when the key is absent.
   */
  async getAllowance(owner: string, spender: string): Promise<bigint> {
    const key = tokenAllowanceKey(owner, spender);
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.programId,
        "allowances",
        key,
      );
      return parseIntLiteral(raw);
    } catch {
      return 0n;
    }
  }

  /**
   * On-chain `balance_of(account) -> u128`, read from the IARC22 `balances`
   * mapping (falling back to `account` if `balances` is absent). Returns `0n`
   * when the account has no balance entry.
   */
  async getBalanceOf(account: string): Promise<bigint> {
    const mappingNames = await this.networkClient.getProgramMappingNames(this.programId);
    const balanceMappingName = mappingNames.includes("balances")
      ? "balances"
      : mappingNames.includes("account")
        ? "account"
        : null;
    if (!balanceMappingName) {
      throw new Error("No public balance mapping found (no 'balances' or 'account').");
    }
    try {
      const raw = await this.networkClient.getProgramMappingValue(
        this.programId,
        balanceMappingName,
        account,
      );
      return parseIntLiteral(raw);
    } catch {
      return 0n;
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private async execute(
    functionName: string,
    inputs: string[],
    options: ExecuteOptions,
    extraImports?: Record<string, string>,
  ): Promise<string> {
    if (this.account === undefined) {
      throw new Error("Arc22Service was constructed without a privateKey");
    }
    const imports = { ...this.programImports, ...extraImports };
    if (this.proverUri !== undefined) {
      return this.executeDelegated(functionName, inputs, options, imports);
    }
    const keySearchParams = { cacheKey: `${this.programId}:${functionName}` };
    return this.programManager.execute({
      programName: this.programId,
      functionName,
      priorityFee: options.priorityFee ?? 0,
      privateFee: options.privateFee ?? false,
      inputs,
      ...(this.programSource !== undefined ? { program: this.programSource } : {}),
      ...(Object.keys(imports).length > 0 ? { imports } : {}),
      ...(options.feeRecord !== undefined ? { feeRecord: options.feeRecord } : {}),
      keySearchParams,
    });
  }

  private async executeDelegated(
    functionName: string,
    inputs: string[],
    options: ExecuteOptions,
    imports: Record<string, string>,
  ): Promise<string> {
    const provingRequest = await this.programManager.provingRequest({
      programName: this.programId,
      functionName,
      priorityFee: options.priorityFee ?? 0,
      privateFee: options.privateFee ?? false,
      inputs,
      broadcast: true,
      unchecked: false,
      ...(this.programSource !== undefined ? { programSource: this.programSource } : {}),
      ...(Object.keys(imports).length > 0 ? { programImports: imports } : {}),
      ...(options.feeRecord !== undefined ? { feeRecord: options.feeRecord } : {}),
    });
    const response = await this.networkClient.submitProvingRequest({
      provingRequest,
      ...(this.proverApiKey !== undefined ? { apiKey: this.proverApiKey } : {}),
      ...(this.proverConsumerId !== undefined ? { consumerId: this.proverConsumerId } : {}),
    });

    const broadcast = response.broadcast_result;
    if (broadcast.status.toLowerCase() !== "accepted") {
      const detail = "message" in broadcast ? broadcast.message : undefined;
      throw new Error(
        `proving service failed to broadcast the transaction (status: ${broadcast.status})${detail ? `: ${detail}` : ""}`,
      );
    }
    return response.transaction.id;
  }
}

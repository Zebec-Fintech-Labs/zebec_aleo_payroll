/**
 * `PayrollClient` — high-level interface to the `test_zebec_payroll_v3.aleo` program:
 * stream lifecycle operations, admin configuration, and mapping reads.
 */

import {
  Account,
  AleoKeyProvider,
  AleoNetworkClient,
  ProgramManager,
  type RecordPlaintext,
} from "@provablehq/sdk/testnet.js";

import { feeTierKey, whitelistKey } from "./hashing.js";
import { computeStreamFee, computeTopupAmount, computeWithdrawableAmount, nowSeconds } from "./math.js";
import {
  configToPlaintext,
  createStreamParamsToPlaintext,
  fieldLiteral,
  identLiteral,
  merkleProofsToPlaintext,
  parseBoolLiteral,
  parseFeeTier,
  parsePayrollConfig,
  parseStreamAnchor,
  streamAnchorToPlaintext,
  tokenPriceToPlaintext,
} from "./plaintext.js";
import { findCreditsRecord, findTicketRecord, findTokenRecord } from "./records.js";
import type {
  Config,
  CreateStreamParams,
  ExecuteOptions,
  FeeTier,
  MerkleProof,
  PayrollClientOptions as PayrollServiceOptions,
  PayrollConfig,
  StreamAnchor,
  TokenPrice,
} from "./types.js";
import type { WithdrawableAmounts } from "./math.js";
import type { TicketRecordName } from "./records.js";

export const DEFAULT_ENDPOINT = "https://api.explorer.provable.com/v1";
export const PROGRAM_ID = "test_zebec_payroll_v3.aleo";

export class PayrollService {
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

  constructor(options: PayrollServiceOptions = {}) {
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
   * `"my_token"` — without the `.aleo` suffix), passed as the second on-chain
   * input. `creditRecord` / `tokenRecord` are located automatically when
   * omitted (requires the client to be constructed with `privateKey`).
   */
  async createStreamPrivate(
    params: CreateStreamParams,
    tokenProgram: string,
    config: Config,
    tokenPrice: TokenPrice,
    priceSignature: string,
    feeBps: bigint,
    merkleProofs: [MerkleProof, MerkleProof],
    options: ExecuteOptions & {
      creditRecord?: string | RecordPlaintext;
      tokenRecord?: string | RecordPlaintext;
    } = {},
  ): Promise<string> {
    const depositAmount = params.canTopup ? params.initialBufferAmount : params.amount;
    // The credit record must cover the auto-withdrawal fee plus the stream
    // fee (see the splits in `create_stream_private`).
    const { streamFee } = computeStreamFee(
      params.amount,
      tokenPrice.streamTokenPriceUsd,
      tokenPrice.aleoPriceUsd,
      feeBps,
    );
    let autoWithdrawalFee = 0n;
    if (params.autoWithdrawable) {
      autoWithdrawalFee =
        config.platformFee + (params.duration / params.withdrawFrequency) * config.baseFee;
    }
    const creditRecord =
      options.creditRecord !== undefined
        ? options.creditRecord.toString()
        : await this.findCredits(autoWithdrawalFee + streamFee);
    console.debug(`Found credit record ${creditRecord} covering auto-withdrawal fee ${autoWithdrawalFee} and stream fee ${streamFee}`,
    );
    const tokenRecord =
      options.tokenRecord !== undefined
        ? options.tokenRecord.toString()
        : await this.findToken(`${tokenProgram}.aleo`, depositAmount);
    console.debug(`Found token record ${tokenRecord} covering deposit amount ${depositAmount}`,);
    const tokenProgramId = `${tokenProgram}.aleo`;
    const inputs = [
      createStreamParamsToPlaintext(params),
      identLiteral(tokenProgram),
      configToPlaintext(config),
      tokenPriceToPlaintext(tokenPrice),
      priceSignature,
      `${feeBps}u64`,
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
    const ticketRecord = ticket?.toString() ?? (await this.findTicket("SenderPayrollTicket", streamId));
    return this.execute("pause_resume_stream_private", [ticketRecord], options);
  }

  /**
   * Execute `cancel_private`. The sender ticket record and the on-chain
   * stream anchor are resolved automatically when omitted.
   */
  async cancelStream(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    ticket?: string | RecordPlaintext,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const ticketRecord = ticket?.toString() ?? (await this.findTicket("SenderPayrollTicket", streamId));
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticketRecord, streamAnchorToPlaintext(anchor), `${now}i64`];
    return this.execute("cancel_private", inputs, options, await this.ticketTokenImport(ticketRecord));
  }

  /**
   * Execute `withdraw_private`. The receiver ticket record and the on-chain
   * stream anchor are resolved automatically when omitted.
   */
  async withdraw(
    streamId: string | bigint,
    now: bigint = nowSeconds(),
    ticket?: string | RecordPlaintext,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const ticketRecord = ticket?.toString() ?? (await this.findTicket("ReceiverPayrollTicket", streamId));
    const anchor = await this.getStreamAnchor(streamId);
    const inputs = [ticketRecord, streamAnchorToPlaintext(anchor), `${now}i64`];
    return this.execute("withdraw_private", inputs, options, await this.ticketTokenImport(ticketRecord));
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
      options.ticket?.toString() ?? (await this.findTicket("SenderPayrollTicket", streamId));
    const anchor = await this.getStreamAnchor(streamId);
    const tokenMatch = /token_program:\s*([a-zA-Z0-9_]+)/.exec(ticketRecord);
    const amountMatch = /full_amount:\s*(\d+)u128/.exec(ticketRecord);
    if (tokenMatch === null || amountMatch === null) {
      throw new Error("could not parse token_program / full_amount from the ticket record");
    }
    const tokenProgramId = `${tokenMatch[1]}.aleo`;
    const { topupAmount } = computeTopupAmount(anchor, BigInt(amountMatch[1]!), now, extra);
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

  /** Execute `set_fee_tier` (config admin only). */
  async setFeeTier(
    configName: string | bigint,
    index: number,
    tier: FeeTier,
    options: ExecuteOptions = {},
  ): Promise<string> {
    const inputs = [
      fieldLiteral(configName),
      `${index}u8`,
      `${tier.minAmount}u64`,
      `${tier.maxAmount}u64`,
      `${tier.feeBps}u64`,
    ];
    return this.execute("set_fee_tier", inputs, options);
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
    return parseStreamAnchor(value);
  }

  /** Read and parse `payroll_config[configName]`. */
  async getPayrollConfig(configName: string | bigint): Promise<PayrollConfig> {
    const value = await this.networkClient.getProgramMappingValue(
      this.programId,
      "payroll_configs",
      fieldLiteral(configName),
    );
    return parsePayrollConfig(value);
  }

  /** Read and parse `fee_tiers[feeTierKey(configName, index)]`. */
  async getFeeTier(configName: string | bigint, index: number): Promise<FeeTier> {
    const value = await this.networkClient.getProgramMappingValue(
      this.programId,
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
    // `full_amount` lives on the tickets, not the anchor; the anchor caps
    // vesting at `deposited_amount` only for topup streams. Use the anchor's
    // deposited amount as the vesting base for the preview.
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

  /** Find a payroll ticket record of the client's account. */
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
      throw new Error("PayrollClient was constructed without a privateKey");
    }
    // Dynamic call targets (e.g. the IARC22 token program) are not static
    // imports of the payroll program, so their sources must be supplied
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
      // preparedProgram: await this.programManager.prepareProgram({
      //   programName: this.programId, functionName, programImports: imports, ...(this.programSource !== undefined ? { programSource: this.programSource } : {})
      // }),
      unchecked: false,
      ...(this.programSource !== undefined ? { programSource: this.programSource } : {}),
      ...(Object.keys(imports).length > 0 ? { programImports: imports } : {}),
      ...(options.feeRecord !== undefined ? { feeRecord: options.feeRecord } : {}),
    });
    // try {
    // console.log("proving request authorization:", provingRequest.authorization().toString());
    // } catch (e) {
    // console.log("could not dump proving request authorization:", (e as Error).message ?? e);
    // }
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
   * Extract the `token_program` identifier from a payroll ticket record
   * plaintext and load the source of the corresponding token program, as
   * required for the dynamic token calls of `withdraw_private` and
   * `cancel_private`.
   */
  private async ticketTokenImport(ticketRecord: string): Promise<Record<string, string>> {
    const match = /token_program:\s*([a-zA-Z0-9_]+)/.exec(ticketRecord);
    if (match === null) {
      throw new Error("could not parse token_program from ticket record");
    }
    const programId = `${match[1]}.aleo`;
    return { [programId]: await this.loadProgramSource(programId) };
  }

  private requirePrivateKey(): string {
    if (this.privateKey === undefined) {
      throw new Error("PayrollClient was constructed without a privateKey");
    }
    return this.privateKey;
  }
}

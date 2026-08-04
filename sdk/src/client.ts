/**
 * `PayrollClient` — high-level interface to the `aacs_payroll.aleo` program:
 * stream lifecycle operations, admin configuration, and mapping reads.
 */

import {
  Account,
  AleoNetworkClient,
  ProgramManager,
  type RecordPlaintext,
} from "@provablehq/sdk/testnet.js";

import { feeTierKey, whitelistKey } from "./hashing.js";
import { computeStreamFee, computeWithdrawableAmount, nowSeconds } from "./math.js";
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
export const PROGRAM_ID = "aacs_payroll.aleo";

export class PayrollService {
  readonly programId: string;
  readonly networkClient: AleoNetworkClient;
  readonly programManager: ProgramManager;
  readonly account?: Account;

  private readonly privateKey?: string;
  private readonly programSource?: string;
  private readonly programImports?: Record<string, string>;

  constructor(options: PayrollServiceOptions = {}) {
    const host = options.host ?? DEFAULT_ENDPOINT;
    this.programId = options.programId ?? PROGRAM_ID;
    this.networkClient = new AleoNetworkClient(host);
    this.programManager = new ProgramManager(host);
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
  }

  // =======================================================================
  // User: stream lifecycle
  // =======================================================================

  /**
   * Execute `create_stream_private`.
   *
   * `creditRecord` / `tokenRecord` are located automatically when omitted
   * (requires the client to be constructed with `privateKey`).
   */
  async createStreamPrivate(
    params: CreateStreamParams,
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
    const tokenRecord =
      options.tokenRecord !== undefined
        ? options.tokenRecord.toString()
        : await this.findToken(`${params.tokenProgram}.aleo`, depositAmount);
    const inputs = [
      createStreamParamsToPlaintext(params),
      configToPlaintext(config),
      tokenPriceToPlaintext(tokenPrice),
      priceSignature,
      `${feeBps}u64`,
      creditRecord,
      tokenRecord,
      merkleProofsToPlaintext(merkleProofs),
    ];
    return this.execute("create_stream_private", inputs, options);
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
    return this.execute("cancel_private", inputs, options);
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
    return this.execute("withdraw_private", inputs, options);
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
      "payroll_config",
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
  ): Promise<string> {
    if (this.account === undefined) {
      throw new Error("PayrollClient was constructed without a privateKey");
    }
    return this.programManager.execute({
      programName: this.programId,
      functionName,
      priorityFee: options.priorityFee ?? 0,
      privateFee: options.privateFee ?? false,
      inputs,
      ...(this.programSource !== undefined ? { program: this.programSource } : {}),
      ...(this.programImports !== undefined ? { imports: this.programImports } : {}),
      ...(options.feeRecord !== undefined ? { feeRecord: options.feeRecord } : {}),
    });
  }

  private requirePrivateKey(): string {
    if (this.privateKey === undefined) {
      throw new Error("PayrollClient was constructed without a privateKey");
    }
    return this.privateKey;
  }
}

/**
 * TypeScript mirrors of the Leo structs in `test_zebec_payroll_v4.aleo` (see
 * `src/main.leo` at the repository root) plus SDK option types.
 *
 * Conventions used across the SDK:
 * - Aleo `field` values are represented as strings, either canonical
 *   (`"123field"`) or bare digits (`"123"`); both are accepted on input and
 *   canonical form is produced on output. `bigint` is also accepted on input.
 * - Aleo `identifier` values (e.g. `token_program`) are plain identifier
 *   strings without quotes (`"my_token_program"`).
 * - Aleo addresses are `aleo1...` strings.
 * - Integer types (`u8`/`u32`/`u64`/`u128`/`i64`) are `bigint`.
 */

/** Leo `Payroll` struct, as stored in the `payrolls` mapping (public streams only). */
export interface Payroll {
  streamId: string;
  /** Config (tenant) the stream was created under. */
  config: string;
  sender: string;
  receiver: string;
  fullAmount: bigint;
  tokenProgram: string;
  isCancelable: boolean;
  isPausable: boolean;
  autoWithdrawable: boolean;
  canTopup: boolean;
  topupCount: bigint;
  initialized: boolean;
}

/** Leo `PayrollConfig` struct, as stored in the `payroll_config` mapping. */
export interface PayrollConfig {
  admin: string;
  feeVault: string;
  withdrawer: string;
  baseFee: bigint;
  platformFee: bigint;
  initialized: boolean;
}

/** Leo `StreamAnchor` struct, as stored in the `stream_anchors` mapping. */
export interface StreamAnchor {
  streamId: string;
  startTime: bigint;
  duration: bigint;
  paused: boolean;
  canceled: boolean;
  canceledAt: bigint;
  depositedAmount: bigint;
  coveredUntil: bigint;
  lastPausedTime: bigint;
  pausedInterval: bigint;
  withdrawnAmount: bigint;
  isPublic: boolean;
  createdTimestamp: bigint;
  initialized: boolean;
}

/** Leo `CreateStreamParams` struct (input of `create_stream_private`). */
export interface CreateStreamParams {
  receiver: string;
  /** Randomness for the stream id (a `field`). */
  streamId: string | bigint;
  amount: bigint;
  startTime: bigint;
  duration: bigint;
  isCancelable: boolean;
  isPausable: boolean;
  autoWithdrawable: boolean;
  withdrawFrequency: bigint;
  startNow: boolean;
  canTopup: boolean;
  initialBufferAmount: bigint;
}

/** Leo `Config` struct (input of `create_stream_private`). */
export interface Config {
  /** The `field` key of the config in the `payroll_config` mapping. */
  configName: string | bigint;
  admin: string;
  feeVault: string;
  withdrawer: string;
  baseFee: bigint;
  platformFee: bigint;
}

/** Leo `TokenPrice` struct. Prices are USD with 6 decimals. */
export interface TokenPrice {
  /**
   * Config name (`field`) this price is signed for. Binds the admin's
   * signature to one payroll config so it cannot be replayed elsewhere.
   */
  config: string | bigint;
  /** Identifier of the stream token program. */
  streamToken: string;
  streamTokenPriceUsd: bigint;
  aleoPriceUsd: bigint;
  priceExpiry: bigint;
  /** Unique nonce (a `field`), used for replay protection. */
  nonce: string | bigint;
}

/** `iarc22::MerkleProof` struct (16 siblings). */
export interface MerkleProof {
  /** 16 field elements. */
  siblings: (string | bigint)[];
  leafIndex: number;
}

/** Options for constructing a {@link PayrollClient}. */
export interface PayrollClientOptions {
  /** API host. Defaults to the testnet explorer API. */
  host?: string;
  /** Program id. Defaults to `test_zebec_payroll_v4.aleo`. */
  programId?: string;
  /** Private key of the transacting account (`APrivateKey1...`). */
  privateKey?: string;
  /**
   * Compiled program source (`build/test_zebec_payroll_v4/test_zebec_payroll_v4.aleo`). When
   * provided, it is used for executions instead of fetching the (deployed)
   * program from the network — useful before the program is deployed.
   */
  programSource?: string;
  /** Imported program sources keyed by program id (e.g. `credits.aleo`). */
  programImports?: Record<string, string>;
  /**
   * Base URI of a delegated proving service (e.g. `https://<host>/testnet`;
   * the SDK POSTs to `<proverUri>/prove/request`). When set, transactions are
   * proven remotely and broadcast by the service instead of being proven
   * locally — use this on machines without enough RAM/CPU to synthesize
   * proving keys and proofs locally.
   */
  proverUri?: string;
  /**
   * Provable API key for the delegated proving service (register a free
   * consumer via `POST https://api.provable.com/consumers`). Required when
   * `proverUri` points at Provable's DPS; the SDK mints/refreshes JWTs
   * automatically. Unneeded for a self-hosted prover.
   */
  proverApiKey?: string;
  /** Provable consumer id paired with `proverApiKey`. */
  proverConsumerId?: string;
}

/** Per-execution options (fee handling). */
export interface ExecuteOptions {
  /** Priority fee in microcredits. Defaults to 0. */
  priorityFee?: number;
  /** Pay the fee with a private credits record. Defaults to false. */
  privateFee?: boolean;
  /** Fee record (plaintext string) to use when `privateFee` is true. */
  feeRecord?: string;
}

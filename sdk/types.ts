/**
 * TypeScript mirrors of the Leo structs in `test_zebec_stream_v3.aleo` (see
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

/** Leo `Stream` struct, as stored in the `streams` mapping (public streams only). */
export interface Stream {
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
}

/** Leo `StreamConfig` struct, as stored in the `stream_config` mapping. */
export interface StreamConfig {
  admin: string;
  feeVault: string;
  withdrawer: string;
  baseFee: bigint;
  platformFee: bigint;
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
  lastPausedTime: bigint;
  pausedInterval: bigint;
  withdrawnAmount: bigint;
  isPublic: boolean;
  createdTimestamp: bigint;
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
  /** The `field` key of the config in the `stream_config` mapping. */
  configName: string | bigint;
  admin: string;
  feeVault: string;
  withdrawer: string;
  baseFee: bigint;
  platformFee: bigint;
}

/** Leo `StreamTokenFee` struct — admin-signed fee for a single create transaction. */
export interface StreamTokenFee {
  /**
   * Config name (`field`) this fee is signed for. Binds the admin's
   * signature to one stream config so it cannot be replayed elsewhere.
   */
  config: string | bigint;
  /** Identifier of the stream token program. */
  streamToken: string;
  /** Admin-signed stream fee amount in stream-token units (Leo `u128`). */
  streamFeeAmount: bigint;
  /** Unix timestamp after which this signed fee expires. */
  expiry: bigint;
  /** Unique nonce (a `field`), used for replay protection. */
  nonce: string | bigint;
}

/** @deprecated Use {@link StreamTokenFee} instead. */
export type TokenPrice = StreamTokenFee;

/** Leo `SenderStreamTicket` record (ticket_type 0) — authorizes pause/resume/topup/cancel. */
export interface SenderTicket {
  owner: string;
  ticketType: bigint;
  /** Config (tenant) the stream was created under. */
  config: string;
  streamId: string;
  receiver: string;
  tokenProgram: string;
  fullAmount: bigint;
  isCancelable: boolean;
  isPausable: boolean;
  canTopup: boolean;
  topupCount: bigint;
}

/** Leo `ReceiverStreamTicket` record (ticket_type 1) — authorizes withdraw. */
export interface ReceiverTicket {
  owner: string;
  ticketType: bigint;
  /** Config (tenant) the stream was created under. */
  config: string;
  sender: string;
  tokenProgram: string;
  fullAmount: bigint;
  autoWithdrawable: boolean;
  streamId: string;
}

/** Leo `WithdrawerStreamTicket` record (ticket_type 2) — authorizes auto-withdraw. */
export interface WithdrawerTicket {
  owner: string;
  ticketType: bigint;
  /** Config (tenant) the stream was created under; binds the withdrawer to it. */
  config: string;
  fullAmount: bigint;
  streamId: string;
  sender: string;
  receiver: string;
  tokenProgram: string;
  autoWithdrawable: boolean;
}

/** `iarc22::MerkleProof` struct (16 siblings). */
export interface MerkleProof {
  /** 16 field elements. */
  siblings: (string | bigint)[];
  leafIndex: number;
}

/** Relationship of an account to a listed stream. */
export type StreamDirection = "outgoing" | "incoming" | "both";

/** One entry of {@link StreamClient.listPublicStreams}. */
export interface ListedStream {
  streamId: string;
  direction: StreamDirection;
  /** On-chain anchor; `undefined` when the anchor read fails. */
  anchor?: StreamAnchor | undefined;
  /** Public stream entry; `undefined` for private streams or failed reads. */
  stream?: Stream | undefined;
}

/** Options for constructing a {@link StreamClient}. */
export interface StreamClientOptions {
  /** API host. Defaults to the testnet explorer API. */
  host?: string;
  /** Program id. Defaults to `test_zebec_stream_v3.aleo`. */
  programId?: string;
  /** Private key of the transacting account (`APrivateKey1...`). */
  privateKey?: string;
  /**
   * Compiled program source (`build/test_zebec_stream_v3/test_zebec_stream_v3.aleo`). When
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

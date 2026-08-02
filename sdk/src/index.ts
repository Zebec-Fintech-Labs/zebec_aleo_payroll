/**
 * aacs-payroll-sdk — TypeScript SDK for the `aacs_payroll.aleo` program.
 */

export {
  PayrollService as PayrollClient,
  DEFAULT_TESTNET_HOST,
  PROGRAM_ID,
} from "./client.js";

export {
  createStreamParamsToPlaintext,
  configToPlaintext,
  tokenPriceToPlaintext,
  streamAnchorToPlaintext,
  merkleProofToPlaintext,
  merkleProofsToPlaintext,
  fieldLiteral,
  identLiteral,
  parseStructMembers,
  parseStreamAnchor,
  parsePayrollConfig,
  parseFeeTier,
  parseIntLiteral,
  parseBoolLiteral,
  parseFieldLiteral,
} from "./plaintext.js";

export {
  hashPlaintextToField,
  configNameToField,
  feeTierKey,
  whitelistKey,
  tokenPriceMessage,
} from "./hashing.js";

export {
  computeStreamFee,
  computeWithdrawableAmount,
  nowSeconds,
  USD_PRICE_DECIMALS_SCALE,
  BPS_DENOMINATOR,
  MAX_FEE_TIERS,
} from "./math.js";
export type { StreamFee, WithdrawableAmounts } from "./math.js";

export { signTokenPrice, verifyTokenPriceSignature } from "./signing.js";

export {
  findCreditsRecord,
  findTokenRecord,
  findTicketRecord,
} from "./records.js";
export type { TicketRecordName } from "./records.js";

export type {
  Config,
  CreateStreamParams,
  ExecuteOptions,
  FeeTier,
  MerkleProof,
  PayrollClientOptions,
  PayrollConfig,
  StreamAnchor,
  TokenPrice,
} from "./types.js";

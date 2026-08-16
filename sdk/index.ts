/**
 * zebec-payroll-sdk — TypeScript SDK for the `test_zebec_payroll_v4.aleo` program.
 */

export {
  PayrollService as PayrollClient,
  Arc22Service,
  DEFAULT_ENDPOINT,
  PROGRAM_ID,
} from "./client.js";
export type { Arc22ServiceOptions } from "./client.js";

export {
  createStreamParamsToPlaintext,
  configToPlaintext,
  tokenPriceToPlaintext,
  streamAnchorToPlaintext,
  merkleProofToPlaintext,
  merkleProofsToPlaintext,
  payrollToPlaintext,
  fieldLiteral,
  identLiteral,
  parseStructMembers,
  parseStreamAnchor,
  parsePayroll,
  parsePayrollConfig,
  parseFeeTier,
  parseIntLiteral,
  parseBoolLiteral,
  parseFieldLiteral,
  parseIdentLiteral,
} from "./plaintext.js";

export {
  hashPlaintextToField,
  configNameToField,
  feeTierKey,
  whitelistKey,
  tokenAllowanceKey,
  tokenPriceMessage,
} from "./hashing.js";

export {
  computeStreamFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  nowSeconds,
  USD_PRICE_DECIMALS_SCALE,
  BPS_DENOMINATOR,
  MAX_FEE_TIERS,
} from "./math.js";
export type { StreamFee, TopupAmount, WithdrawableAmounts } from "./math.js";

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
  Payroll,
  PayrollClientOptions,
  PayrollConfig,
  StreamAnchor,
  TokenPrice,
} from "./types.js";

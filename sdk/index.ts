/**
 * zebec-payroll-sdk — TypeScript SDK for the `test_zebec_payroll_v6.aleo` program.
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
  streamTokenFeeToPlaintext,
  tokenPriceToPlaintext, // @deprecated
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
  parseIntLiteral,
  parseBoolLiteral,
  parseFieldLiteral,
  parseIdentLiteral,
} from "./plaintext.js";

export {
  hashPlaintextToField,
  configNameToField,
  whitelistKey,
  tokenAllowanceKey,
  streamTokenFeeMessage,
  tokenPriceMessage, // @deprecated
} from "./hashing.js";

export {
  computeStreamFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  nowSeconds,
  USD_PRICE_DECIMALS_SCALE,
  BPS_DENOMINATOR,
  DEFAULT_FEE_BPS,
} from "./math.js";
export type { StreamFee, TopupAmount, WithdrawableAmounts } from "./math.js";

export {
  signStreamTokenFee,
  verifyStreamTokenFeeSignature,
  signTokenPrice,           // @deprecated
  verifyTokenPriceSignature, // @deprecated
} from "./signing.js";

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
  MerkleProof,
  Payroll,
  PayrollClientOptions,
  PayrollConfig,
  StreamAnchor,
  StreamTokenFee,
  TokenPrice, // @deprecated alias for StreamTokenFee
} from "./types.js";

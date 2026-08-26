/**
 * zebec-payroll-sdk — TypeScript SDK for the `test_zebec_payroll_v9.aleo` program.
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
  parseSenderTicket,
  parseReceiverTicket,
  parseWithdrawerTicket,
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
  computeStreamFee, // @deprecated
  computeAutoWithdrawalFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  isWithdrawFrequencyValid,
  nowSeconds,
  USD_PRICE_DECIMALS_SCALE, // @deprecated
  BPS_DENOMINATOR, // @deprecated
  DEFAULT_FEE_BPS, // @deprecated
  DEFAULT_WITHDRAW_FREQUENCY,
  SPLIT_FEE,
  WITHDRAW_FREQUENCIES,
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
  ReceiverTicket,
  SenderTicket,
  StreamAnchor,
  StreamTokenFee,
  WithdrawerTicket,
  TokenPrice, // @deprecated alias for StreamTokenFee
} from "./types.js";

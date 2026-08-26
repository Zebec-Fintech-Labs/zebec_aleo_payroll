/**
 * Serializers from SDK types to Leo plaintext literal strings (used as
 * transaction inputs and hashing preimages) and parsers for plaintext values
 * returned by mapping queries.
 *
 * IMPORTANT: struct members are always emitted in the exact declaration order
 * of the corresponding Leo struct — `BHP256::hash_to_field` hashes the member
 * bits in declaration order, so reordering would change every derived key.
 */

import { Field, Plaintext } from "@provablehq/sdk/testnet.js";

import type {
  Config,
  CreateStreamParams,
  MerkleProof,
  Payroll,
  PayrollConfig,
  ReceiverTicket,
  SenderTicket,
  StreamAnchor,
  StreamTokenFee,
  WithdrawerTicket,
} from "./types.js";

/** Normalize a field value to its canonical literal form (`"123field"`). */
export function fieldLiteral(value: string | bigint | number): string {
  const trimmed = (typeof value === "string" ? value : `${value}`).trim();
  const literal = trimmed.endsWith("field") ? trimmed : `${trimmed}field`;
  // Validate with the snarkVM parser and return its canonical form.
  return Field.fromString(literal).toString();
}

/** Render a bare identifier literal (e.g. `my_token`) using Leo's single-quote syntax. */
export function identLiteral(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(trimmed)) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `'${trimmed}'`;
}

/** Serialize a `Payroll` struct to its Leo plaintext literal. */
export function payrollToPlaintext(p: Payroll): string {
  return validated(
    `{ stream_id: ${fieldLiteral(p.streamId)}, config: ${fieldLiteral(p.config)}, ` +
    `sender: ${p.sender}, receiver: ${p.receiver}, ` +
    `full_amount: ${p.fullAmount}u128, token_program: ${identLiteral(p.tokenProgram)}, ` +
    `is_cancelable: ${boolLiteral(p.isCancelable)}, is_pausable: ${boolLiteral(p.isPausable)}, ` +
    `auto_withdrawable: ${boolLiteral(p.autoWithdrawable)}, can_topup: ${boolLiteral(p.canTopup)}, ` +
    `topup_count: ${p.topupCount}u64, initialized: ${boolLiteral(p.initialized)} }`
  );
}

function boolLiteral(value: boolean): string {
  return value ? "true" : "false";
}

/**
 * Validate a serialized plaintext value with the snarkVM parser, returning
 * the original single-line text unchanged.
 */
function validated(text: string): string {
  Plaintext.fromString(text).free();
  return text;
}

/** Serialize a `CreateStreamParams` struct to its Leo plaintext literal. */
export function createStreamParamsToPlaintext(p: CreateStreamParams): string {
  return validated(
    `{ receiver: ${p.receiver}, stream_id: ${fieldLiteral(p.streamId)}, ` +
    `amount: ${p.amount}u128, start_time: ${p.startTime}i64, ` +
    `duration: ${p.duration}u64, is_cancelable: ${boolLiteral(p.isCancelable)}, ` +
    `is_pausable: ${boolLiteral(p.isPausable)}, ` +
    `auto_withdrawable: ${boolLiteral(p.autoWithdrawable)}, ` +
    `withdraw_frequency: ${p.withdrawFrequency}u64, ` +
    `start_now: ${boolLiteral(p.startNow)}, can_topup: ${boolLiteral(p.canTopup)}, ` +
    `initial_buffer_amount: ${p.initialBufferAmount}u128 }`
  );
}

/** Serialize a `Config` struct to its Leo plaintext literal. */
export function configToPlaintext(c: Config): string {
  return validated(
    `{ config_name: ${fieldLiteral(c.configName)}, admin: ${c.admin}, ` +
    `fee_vault: ${c.feeVault}, withdrawer: ${c.withdrawer}, ` +
    `base_fee: ${c.baseFee}u64, platform_fee: ${c.platformFee}u64 }`
  );
}

/**
 * Serialize a `StreamTokenFee` struct to its Leo plaintext literal.
 *
 * Member order matches the Leo struct declaration exactly — BHP256 hashes
 * member bits in declaration order, so the order here determines the signed
 * message that `create_stream_private` and `create_stream_public` verify
 * on-chain.
 *
 * Leo struct declaration order:
 *   config: field, stream_token: identifier,
 *   stream_fee_amount: u64, expiry: i64, nonce: field
 */
export function streamTokenFeeToPlaintext(tf: StreamTokenFee): string {
  return validated(
    `{ config: ${fieldLiteral(tf.config)}, ` +
    `stream_token: ${identLiteral(tf.streamToken)}, ` +
    `stream_fee_amount: ${tf.streamFeeAmount}u64, ` +
    `expiry: ${tf.expiry}i64, nonce: ${fieldLiteral(tf.nonce)} }`
  );
}

/** @deprecated Use {@link streamTokenFeeToPlaintext} instead. */
export const tokenPriceToPlaintext = streamTokenFeeToPlaintext;

/** Serialize a `StreamAnchor` struct to its Leo plaintext literal. */
export function streamAnchorToPlaintext(a: StreamAnchor): string {
  return validated(
    `{ stream_id: ${fieldLiteral(a.streamId)}, start_time: ${a.startTime}i64, ` +
    `duration: ${a.duration}u64, paused: ${boolLiteral(a.paused)}, ` +
    `canceled: ${boolLiteral(a.canceled)}, canceled_at: ${a.canceledAt}i64, ` +
    `deposited_amount: ${a.depositedAmount}u128, ` +
    `last_paused_time: ${a.lastPausedTime}i64, ` +
    `paused_interval: ${a.pausedInterval}u64, ` +
    `withdrawn_amount: ${a.withdrawnAmount}u128, ` +
    `is_public: ${boolLiteral(a.isPublic)}, ` +
    `created_timestamp: ${a.createdTimestamp}i64, ` +
    `initialized: ${boolLiteral(a.initialized)} }`
  );
}

/** Serialize one `iarc22::MerkleProof` struct to its Leo plaintext literal. */
export function merkleProofToPlaintext(proof: MerkleProof): string {
  if (proof.siblings.length !== 16) {
    throw new Error(`MerkleProof needs exactly 16 siblings, got ${proof.siblings.length}`);
  }
  const siblings = proof.siblings.map((s) => fieldLiteral(s)).join(", ");
  return validated(`{ siblings: [${siblings}], leaf_index: ${proof.leafIndex}u32 }`);
}

/** Serialize the `[iarc22::MerkleProof; 2]` array used by token transfers. */
export function merkleProofsToPlaintext(proofs: [MerkleProof, MerkleProof]): string {
  return validated(`[${merkleProofToPlaintext(proofs[0])}, ${merkleProofToPlaintext(proofs[1])}]`);
}

// =========================================================================
// Parsing
// =========================================================================

/**
 * Strip an optional trailing visibility suffix (`.private`, `.public`,
 * `.constant`) from a plaintext member value. Wallet-decrypted record
 * plaintexts carry these suffixes on every member (e.g. `1000u64.private`),
 * while mapping queries return bare literals; stripping here normalizes both.
 */
export function stripVisibilitySuffix(value: string): string {
  return value.replace(/\.(?:private|public|constant)$/i, "").trim();
}

/** Split a struct body into top-level `name: value` members. */
export function parseStructMembers(plaintext: string): Map<string, string> {
  const text = plaintext.trim();
  if (!text.startsWith("{") || !text.endsWith("}")) {
    throw new Error(`not a struct literal: ${plaintext.slice(0, 64)}`);
  }
  const inner = text.slice(1, -1);
  const members = new Map<string, string>();
  let depth = 0;
  let start = 0;
  const parts: string[] = [];
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "{" || ch === "[" || ch === "(") depth++;
    else if (ch === "}" || ch === "]" || ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      parts.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  const last = inner.slice(start).trim();
  if (last.length > 0) parts.push(last);
  for (const part of parts) {
    const colon = part.indexOf(":");
    if (colon < 0) throw new Error(`malformed struct member: ${part}`);
    members.set(part.slice(0, colon).trim(), stripVisibilitySuffix(part.slice(colon + 1)));
  }
  return members;
}

function requireMember(members: Map<string, string>, name: string): string {
  const value = members.get(name);
  if (value === undefined) throw new Error(`missing struct member: ${name}`);
  return value;
}

/** Parse an integer literal (`"3600u64"`, `"-5i64"`, ...) to `bigint`. */
export function parseIntLiteral(value: string): bigint {
  const m = /^(-?\d+)(u8|u16|u32|u64|u128|i8|i16|i32|i64|i128)$/.exec(
    stripVisibilitySuffix(value),
  );
  if (!m) throw new Error(`not an integer literal: ${value}`);
  return BigInt(m[1]!);
}

/** Parse a boolean literal (`"true"` / `"false"`). */
export function parseBoolLiteral(value: string): boolean {
  const v = stripVisibilitySuffix(value);
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`not a boolean literal: ${value}`);
}

/** Normalize a parsed field literal to canonical form (`"123field"`). */
export function parseFieldLiteral(value: string): string {
  return fieldLiteral(stripVisibilitySuffix(value));
}

/** Parse an identifier literal (`"'my_token'"`) to its bare form (`"my_token"`). */
export function parseIdentLiteral(value: string): string {
  const v = stripVisibilitySuffix(value);
  const m = /^'([a-z][a-z0-9_]{0,30})'$/.exec(v);
  if (!m) throw new Error(`not an identifier literal: ${value}`);
  return m[1]!;
}

/** Parse a `Payroll` mapping value. */
export function parsePayroll(plaintext: string): Payroll {
  if (!plaintext) {
    throw new Error("value is empty: " + plaintext);
  }
  const m = parseStructMembers(plaintext);
  return {
    streamId: parseFieldLiteral(requireMember(m, "stream_id")),
    config: parseFieldLiteral(requireMember(m, "config")),
    sender: requireMember(m, "sender"),
    receiver: requireMember(m, "receiver"),
    fullAmount: parseIntLiteral(requireMember(m, "full_amount")),
    tokenProgram: parseIdentLiteral(requireMember(m, "token_program")),
    isCancelable: parseBoolLiteral(requireMember(m, "is_cancelable")),
    isPausable: parseBoolLiteral(requireMember(m, "is_pausable")),
    autoWithdrawable: parseBoolLiteral(requireMember(m, "auto_withdrawable")),
    canTopup: parseBoolLiteral(requireMember(m, "can_topup")),
    topupCount: parseIntLiteral(requireMember(m, "topup_count")),
    initialized: parseBoolLiteral(requireMember(m, "initialized")),
  };
}

/** Parse a `StreamAnchor` mapping value. */
export function parseStreamAnchor(plaintext: string): StreamAnchor {
  if (!plaintext) {
    throw new Error("Plaintext value is empty: " + plaintext);
  }
  const m = parseStructMembers(plaintext);
  return {
    streamId: parseFieldLiteral(requireMember(m, "stream_id")),
    startTime: parseIntLiteral(requireMember(m, "start_time")),
    duration: parseIntLiteral(requireMember(m, "duration")),
    paused: parseBoolLiteral(requireMember(m, "paused")),
    canceled: parseBoolLiteral(requireMember(m, "canceled")),
    canceledAt: parseIntLiteral(requireMember(m, "canceled_at")),
    depositedAmount: parseIntLiteral(requireMember(m, "deposited_amount")),
    lastPausedTime: parseIntLiteral(requireMember(m, "last_paused_time")),
    pausedInterval: parseIntLiteral(requireMember(m, "paused_interval")),
    withdrawnAmount: parseIntLiteral(requireMember(m, "withdrawn_amount")),
    isPublic: parseBoolLiteral(requireMember(m, "is_public")),
    createdTimestamp: parseIntLiteral(requireMember(m, "created_timestamp")),
    initialized: parseBoolLiteral(requireMember(m, "initialized")),
  };
}

/** Parse a `PayrollConfig` mapping value. */
export function parsePayrollConfig(plaintext: string): PayrollConfig {
  if (!plaintext) {
    throw new Error("value is empty: " + plaintext);
  }
  const m = parseStructMembers(plaintext);
  return {
    admin: requireMember(m, "admin"),
    feeVault: requireMember(m, "fee_vault"),
    withdrawer: requireMember(m, "withdrawer"),
    baseFee: parseIntLiteral(requireMember(m, "base_fee")),
    platformFee: parseIntLiteral(requireMember(m, "platform_fee")),
    initialized: parseBoolLiteral(requireMember(m, "initialized")),
  };
}

// =========================================================================
// Ticket record parsing
// =========================================================================

/**
 * Parse a decrypted `SenderPayrollTicket` record plaintext (ticket_type 0).
 * Throws when the plaintext is not a sender ticket.
 */
export function parseSenderTicket(plaintext: string): SenderTicket {
  const m = requireTicketMembers(plaintext, 0);
  return {
    owner: requireMember(m, "owner"),
    ticketType: parseIntLiteral(requireMember(m, "ticket_type")),
    config: parseFieldLiteral(requireMember(m, "config")),
    streamId: parseFieldLiteral(requireMember(m, "stream_id")),
    receiver: requireMember(m, "receiver"),
    tokenProgram: parseIdentLiteral(requireMember(m, "token_program")),
    fullAmount: parseIntLiteral(requireMember(m, "full_amount")),
    isCancelable: parseBoolLiteral(requireMember(m, "is_cancelable")),
    isPausable: parseBoolLiteral(requireMember(m, "is_pausable")),
    canTopup: parseBoolLiteral(requireMember(m, "can_topup")),
    topupCount: parseIntLiteral(requireMember(m, "topup_count")),
  };
}

/**
 * Parse a decrypted `ReceiverPayrollTicket` record plaintext (ticket_type 1).
 * Throws when the plaintext is not a receiver ticket.
 */
export function parseReceiverTicket(plaintext: string): ReceiverTicket {
  const m = requireTicketMembers(plaintext, 1);
  return {
    owner: requireMember(m, "owner"),
    ticketType: parseIntLiteral(requireMember(m, "ticket_type")),
    config: parseFieldLiteral(requireMember(m, "config")),
    sender: requireMember(m, "sender"),
    tokenProgram: parseIdentLiteral(requireMember(m, "token_program")),
    fullAmount: parseIntLiteral(requireMember(m, "full_amount")),
    autoWithdrawable: parseBoolLiteral(requireMember(m, "auto_withdrawable")),
    streamId: parseFieldLiteral(requireMember(m, "stream_id")),
  };
}

/**
 * Parse a decrypted `WithdrawerPayrollTicket` record plaintext (ticket_type 2).
 * Throws when the plaintext is not a withdrawer ticket.
 */
export function parseWithdrawerTicket(plaintext: string): WithdrawerTicket {
  const m = requireTicketMembers(plaintext, 2);
  return {
    owner: requireMember(m, "owner"),
    ticketType: parseIntLiteral(requireMember(m, "ticket_type")),
    config: parseFieldLiteral(requireMember(m, "config")),
    fullAmount: parseIntLiteral(requireMember(m, "full_amount")),
    streamId: parseFieldLiteral(requireMember(m, "stream_id")),
    sender: requireMember(m, "sender"),
    receiver: requireMember(m, "receiver"),
    tokenProgram: parseIdentLiteral(requireMember(m, "token_program")),
    autoWithdrawable: parseBoolLiteral(requireMember(m, "auto_withdrawable")),
  };
}

/** Validate the ticket_type of a record plaintext and return its members. */
function requireTicketMembers(
  plaintext: string,
  expectedType: number,
): Map<string, string> {
  if (!plaintext) {
    throw new Error("value is empty: " + plaintext);
  }
  const m = parseStructMembers(plaintext);
  const typeMatch = /(\d+)u8/.exec(requireMember(m, "ticket_type"));
  if (!typeMatch || Number(typeMatch[1]) !== expectedType) {
    throw new Error(
      `not a ticket_type ${expectedType} record (got ${requireMember(m, "ticket_type")})`,
    );
  }
  return m;
}




// watch-test

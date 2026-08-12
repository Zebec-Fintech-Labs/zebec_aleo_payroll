/**
 * Serializers from SDK types to Leo plaintext literal strings (used as
 * transaction inputs and hashing preimages) and parsers for plaintext values
 * returned by mapping queries.
 *
 * IMPORTANT: struct members are always emitted in the exact declaration order
 * of the corresponding Leo struct — `BHP256::hash_to_field` hashes the member
 * bits in declaration order, so reordering would change every derived key.
 */

import type {
  Config,
  CreateStreamParams,
  FeeTier,
  MerkleProof,
  PayrollConfig,
  StreamAnchor,
  TokenPrice,
} from "./types.js";

/** Normalize a field value to its canonical literal form (`"123field"`). */
export function fieldLiteral(value: string | bigint | number): string {
  if (typeof value === "bigint" || typeof value === "number") {
    return `${value}field`;
  }
  const trimmed = value.trim();
  return trimmed.endsWith("field") ? trimmed : `${trimmed}field`;
}

/** Render a bare identifier literal (e.g. `my_token`) using Leo's single-quote syntax. */
export function identLiteral(name: string): string {
  const trimmed = name.trim();
  if (!/^[a-z][a-z0-9_]{0,30}$/.test(trimmed)) {
    throw new Error(`invalid identifier: ${name}`);
  }
  return `'${trimmed}'`;
}

function boolLiteral(value: boolean): string {
  return value ? "true" : "false";
}

/** Serialize a `CreateStreamParams` struct to its Leo plaintext literal. */
export function createStreamParamsToPlaintext(p: CreateStreamParams): string {
  return (
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
  return (
    `{ config_name: ${fieldLiteral(c.configName)}, admin: ${c.admin}, ` +
    `fee_vault: ${c.feeVault}, withdrawer: ${c.withdrawer}, ` +
    `base_fee: ${c.baseFee}u64, platform_fee: ${c.platformFee}u64 }`
  );
}

/** Serialize a `TokenPrice` struct to its Leo plaintext literal. */
export function tokenPriceToPlaintext(tp: TokenPrice): string {
  return (
    `{ config: ${fieldLiteral(tp.config)}, ` +
    `stream_token: ${identLiteral(tp.streamToken)}, ` +
    `stream_token_price_usd: ${tp.streamTokenPriceUsd}u64, ` +
    `aleo_price_usd: ${tp.aleoPriceUsd}u64, ` +
    `price_expiry: ${tp.priceExpiry}i64, nonce: ${fieldLiteral(tp.nonce)} }`
  );
}

/** Serialize a `StreamAnchor` struct to its Leo plaintext literal. */
export function streamAnchorToPlaintext(a: StreamAnchor): string {
  return (
    `{ stream_id: ${fieldLiteral(a.streamId)}, start_time: ${a.startTime}i64, ` +
    `duration: ${a.duration}u64, paused: ${boolLiteral(a.paused)}, ` +
    `canceled: ${boolLiteral(a.canceled)}, canceled_at: ${a.canceledAt}i64, ` +
    `deposited_amount: ${a.depositedAmount}u128, ` +
    `covered_until: ${a.coveredUntil}i64, ` +
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
  return `{ siblings: [${siblings}], leaf_index: ${proof.leafIndex}u32 }`;
}

/** Serialize the `[iarc22::MerkleProof; 2]` array used by token transfers. */
export function merkleProofsToPlaintext(proofs: [MerkleProof, MerkleProof]): string {
  return `[${merkleProofToPlaintext(proofs[0])}, ${merkleProofToPlaintext(proofs[1])}]`;
}

// =========================================================================
// Parsing
// =========================================================================

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
    members.set(part.slice(0, colon).trim(), part.slice(colon + 1).trim());
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
  const m = /^(-?\d+)(u8|u16|u32|u64|u128|i8|i16|i32|i64|i128)$/.exec(value.trim());
  if (!m) throw new Error(`not an integer literal: ${value}`);
  return BigInt(m[1]!);
}

/** Parse a boolean literal (`"true"` / `"false"`). */
export function parseBoolLiteral(value: string): boolean {
  const v = value.trim();
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`not a boolean literal: ${value}`);
}

/** Normalize a parsed field literal to canonical form (`"123field"`). */
export function parseFieldLiteral(value: string): string {
  return fieldLiteral(value.trim());
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
    coveredUntil: parseIntLiteral(requireMember(m, "covered_until")),
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

/** Parse a `FeeTier` mapping value. */
export function parseFeeTier(plaintext: string): FeeTier {
  if (!plaintext) {
    throw new Error("value is empty: " + plaintext);
  }
  const m = parseStructMembers(plaintext);
  return {
    minAmount: parseIntLiteral(requireMember(m, "min_amount")),
    maxAmount: parseIntLiteral(requireMember(m, "max_amount")),
    feeBps: parseIntLiteral(requireMember(m, "fee_bps")),
  };
}

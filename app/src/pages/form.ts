/** Small form-parsing helpers shared by the pages. */

import { Field } from "@provablehq/sdk/testnet.js";

/** Parse a non-negative integer string to bigint, or throw a form error. */
export function parseBig(value: string, label: string, { positive = false } = {}): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  const parsed = BigInt(trimmed);
  if (positive && parsed <= 0n) {
    throw new Error(`${label} must be positive`);
  }
  return parsed;
}

/** Parse a fee in microcredits to a JS number. */
export function parseFee(value: string): number {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("fee must be a non-negative integer (microcredits)");
  }
  const fee = Number(trimmed);
  if (!Number.isSafeInteger(fee)) {
    throw new Error("fee is too large");
  }
  return fee;
}

/** Validate an Aleo address / private key shape (no key material checks). */
export function requirePrefix(value: string, prefix: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith(prefix)) {
    throw new Error(`${label} must start with ${prefix}`);
  }
  return trimmed;
}

/** Random 128-bit field value (stream ids). */
export function randomField(): bigint {
  const bytes = Field.random().toBytesLe();
  return BigInt(
    "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(""),
  );
}

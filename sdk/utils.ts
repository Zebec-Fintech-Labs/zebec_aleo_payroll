/**
 * Unit-conversion helpers bridging human-facing amounts (decimal strings like
 * `"2.5"`) and the on-chain integer micro-units (`u128`), plus token-decimals
 * discovery for IARC22 token programs.
 */

import type { AleoNetworkClient } from "@provablehq/sdk/testnet.js";

/**
 * Convert a human amount (`"2.5"`, `2.5`) into integer micro-units at
 * `decimals` precision, returned as a decimal string (safe for `BigInt`).
 * Throws on non-numeric input or more fractional digits than `decimals`.
 */
export function toMicroUnits(amount: string | number, decimals = 6): string {
  const text = String(amount).trim();
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    throw new Error(`invalid amount: ${amount}`);
  }
  const negative = text.startsWith("-");
  const [intPart, fracPart = ""] = (negative ? text.slice(1) : text).split(".");
  if (fracPart.length > decimals) {
    throw new Error(`amount ${amount} has more than ${decimals} decimal places`);
  }
  const micro = BigInt(`${intPart}${fracPart.padEnd(decimals, "0")}`);
  return (negative ? -micro : micro).toString();
}

/**
 * Convert integer micro-units into a human decimal string at `decimals`
 * precision (trailing zeros trimmed): `fromMicroUnits(2500000n) === "2.5"`.
 */
export function fromMicroUnits(amount: bigint | string | number, decimals = 6): string {
  const micro = BigInt(amount);
  const negative = micro < 0n;
  const digits = (negative ? -micro : micro).toString().padStart(decimals + 1, "0");
  const intPart = digits.slice(0, -decimals);
  const fracPart = digits.slice(-decimals).replace(/0+$/, "");
  return `${negative ? "-" : ""}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

/**
 * Read the decimals of an IARC22 token program from its `token_info` mapping
 * (`TokenInfo { ..., decimals: u8, ... }` under the `true` key). Falls back
 * to 6 when the program has no readable `token_info` entry.
 */
export async function getDecimalsByTokenProgram(
  networkClient: AleoNetworkClient,
  tokenProgramId: string,
): Promise<number> {
  try {
    const value = await networkClient.getProgramMappingValue(
      tokenProgramId,
      "token_info",
      "true",
    );
    const match = value ? /decimals:\s*(\d+)u8/.exec(value) : null;
    if (match) {
      return Number(match[1]);
    }
  } catch {
    // Fall through to the default below.
  }
  return 6;
}

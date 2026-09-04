/**
 * Unit conversions between human amounts and the on-chain micro-units used by
 * every `u128` amount in `src/main.leo` (stream amount, initial buffer,
 * deposits, stream fee) and by the `u64` microcredit fees.
 *
 * A silent rounding or sign error here changes the amount that is signed into
 * a `StreamTokenFee` or asserted against a deposit, so the boundaries are
 * pinned explicitly.
 */

import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

import type { AleoNetworkClient } from "@provablehq/sdk/testnet.js";

import {
  fromMicroUnits,
  getDecimalsByTokenProgram,
  toMicroUnits,
} from "../../sdk/utils.js";

describe("toMicroUnits", () => {
  it("scales whole and fractional amounts at the default 6 decimals", () => {
    assert.equal(toMicroUnits("2.5"), "2500000");
    assert.equal(toMicroUnits(2.5), "2500000");
    assert.equal(toMicroUnits("0"), "0");
    assert.equal(toMicroUnits("0.000001"), "1");
    assert.equal(toMicroUnits(1), "1000000");
  });

  it("accepts exactly `decimals` fractional digits and rejects one more", () => {
    assert.equal(toMicroUnits("1.123456", 6), "1123456");
    assert.throws(() => toMicroUnits("1.1234567", 6), /more than 6 decimal places/);
    assert.equal(toMicroUnits("1.12345678", 8), "112345678");
    assert.throws(() => toMicroUnits("1.123456789", 8), /more than 8 decimal places/);
  });

  it("supports zero-decimal tokens", () => {
    assert.equal(toMicroUnits("5", 0), "5");
    assert.throws(() => toMicroUnits("5.1", 0), /more than 0 decimal places/);
  });

  it("keeps the sign of negative amounts", () => {
    // Negative amounts are never valid stream inputs, but the conversion must
    // not silently flip them into a huge unsigned value.
    assert.equal(toMicroUnits("-1.5"), "-1500000");
    assert.equal(toMicroUnits("-0.000001"), "-1");
    assert.equal(BigInt(toMicroUnits("-1.5")) < 0n, true);
  });

  it("tolerates surrounding whitespace and leading zeros", () => {
    assert.equal(toMicroUnits(" 2.5 "), "2500000");
    assert.equal(toMicroUnits("007.5"), "7500000");
  });

  it("rejects anything that is not a plain decimal number", () => {
    for (const bad of ["", "abc", "1.", ".5", "1e6", "1,5", "1.2.3", "+1", "Infinity", "NaN"]) {
      assert.throws(() => toMicroUnits(bad), /invalid amount/, bad);
    }
  });

  it("stays exact past the double-precision range", () => {
    // 18 digits already exceeds Number.MAX_SAFE_INTEGER; the conversion is
    // string-based, so no precision is lost on the way to a u128 input.
    assert.equal(
      toMicroUnits("123456789012345678.123456"),
      "123456789012345678123456",
    );
  });
});

describe("fromMicroUnits", () => {
  it("renders micro-units and trims trailing fraction zeros", () => {
    assert.equal(fromMicroUnits(2_500_000n), "2.5");
    assert.equal(fromMicroUnits(1_000_000n), "1");
    assert.equal(fromMicroUnits(0n), "0");
    assert.equal(fromMicroUnits(1n), "0.000001");
    assert.equal(fromMicroUnits(100n), "0.0001");
  });

  it("accepts strings and numbers as well as bigints", () => {
    assert.equal(fromMicroUnits("2500000"), "2.5");
    assert.equal(fromMicroUnits(2_500_000), "2.5");
  });

  it("keeps the sign of negative micro-units", () => {
    assert.equal(fromMicroUnits(-2_500_000n), "-2.5");
    assert.equal(fromMicroUnits(-1n), "-0.000001");
  });

  it("renders zero-decimal tokens as plain integers", () => {
    assert.equal(fromMicroUnits(123n, 0), "123");
    assert.equal(fromMicroUnits(0n, 0), "0");
    assert.equal(fromMicroUnits(-123n, 0), "-123");
  });

  it("renders the u128 ceiling without loss", () => {
    const max = (1n << 128n) - 1n;
    assert.equal(fromMicroUnits(max), "340282366920938463463374607431768211455".slice(0, -6) + "." + "340282366920938463463374607431768211455".slice(-6));
  });

  it("round-trips with toMicroUnits", () => {
    for (const [amount, decimals] of [
      ["123.456789", 6],
      ["0.000001", 6],
      ["1000000", 6],
      ["0", 6],
      ["-42.5", 6],
      ["7", 0],
      ["1.12345678", 8],
    ] as [string, number][]) {
      assert.equal(fromMicroUnits(toMicroUnits(amount, decimals), decimals), amount, amount);
    }
  });
});

describe("getDecimalsByTokenProgram", () => {
  const clientReturning = (value: string | null | (() => never)) =>
    ({
      getProgramMappingValue: async () => {
        if (typeof value === "function") value();
        return value;
      },
    }) as unknown as AleoNetworkClient;

  it("reads the decimals member out of the token_info struct", async () => {
    const client = clientReturning(
      "{ name: 1field, symbol: 2field, decimals: 8u8, supply: 0u128 }",
    );
    assert.equal(await getDecimalsByTokenProgram(client, "test_token.aleo"), 8);
  });

  it("reads a zero-decimal token", async () => {
    const client = clientReturning("{ decimals: 0u8 }");
    assert.equal(await getDecimalsByTokenProgram(client, "test_token.aleo"), 0);
  });

  it("falls back to 6 when token_info is absent, unreadable or malformed", async () => {
    assert.equal(await getDecimalsByTokenProgram(clientReturning(null), "t.aleo"), 6);
    assert.equal(await getDecimalsByTokenProgram(clientReturning(""), "t.aleo"), 6);
    assert.equal(await getDecimalsByTokenProgram(clientReturning("{ name: 1field }"), "t.aleo"), 6);
    assert.equal(
      await getDecimalsByTokenProgram(
        clientReturning(() => {
          throw new Error("404");
        }),
        "t.aleo",
      ),
      6,
    );
  });
});

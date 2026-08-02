import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

import { computeStreamFee, computeWithdrawableAmount } from "../../src/math.js";

describe("computeStreamFee", () => {
  it("computes usd value and fee like the on-chain function", () => {
    // 1_000_000 tokens at $1.00, aleo at $0.50, 100 bps (1%).
    const { usdValue, streamFee } = computeStreamFee(1_000_000n, 1_000_000n, 500_000n, 100n);
    assert.equal(usdValue, 1_000_000n); // $1.00
    assert.equal(streamFee, 20_000n); // $0.01 fee = 0.02 aleo = 20000 microcredits
  });

  it("truncates like integer division", () => {
    const { usdValue, streamFee } = computeStreamFee(3n, 1_000_000n, 1_000_000n, 33n);
    assert.equal(usdValue, 3n);
    assert.equal(streamFee, 0n); // floor(3 * 33 / 10000) = 0
  });
});

describe("computeWithdrawableAmount", () => {
  const START = 1_000n;
  const DURATION = 100n;
  const FULL = 10_000n;

  it("is zero before the stream starts", () => {
    assert.deepEqual(
      computeWithdrawableAmount(900n, START, DURATION, 0n, FULL, 0n),
      { totalWithdrawable: 0n, currentlyWithdrawable: 0n },
    );
    assert.deepEqual(
      computeWithdrawableAmount(1000n, START, DURATION, 0n, FULL, 0n),
      { totalWithdrawable: 0n, currentlyWithdrawable: 0n },
    );
  });

  it("vests linearly mid-stream", () => {
    assert.deepEqual(
      computeWithdrawableAmount(1050n, START, DURATION, 0n, FULL, 0n),
      { totalWithdrawable: 5_000n, currentlyWithdrawable: 5_000n },
    );
  });

  it("subtracts paused interval and already withdrawn amounts", () => {
    // 60 elapsed, 10 paused -> 50 effective -> 5000 vested, 2000 withdrawn.
    assert.deepEqual(
      computeWithdrawableAmount(1060n, START, DURATION, 10n, FULL, 2_000n),
      { totalWithdrawable: 5_000n, currentlyWithdrawable: 3_000n },
    );
  });

  it("pays out the remainder after the stream ends", () => {
    assert.deepEqual(
      computeWithdrawableAmount(9999n, START, DURATION, 0n, FULL, 4_000n),
      { totalWithdrawable: FULL, currentlyWithdrawable: 6_000n },
    );
  });

  it("is zero when the paused interval eats all elapsed time", () => {
    assert.deepEqual(
      computeWithdrawableAmount(1010n, START, DURATION, 10n, FULL, 0n),
      { totalWithdrawable: 0n, currentlyWithdrawable: 0n },
    );
  });

  it("throws on non-positive duration", () => {
    assert.throws(() => computeWithdrawableAmount(1n, 0n, 0n, 0n, FULL, 0n));
  });
});

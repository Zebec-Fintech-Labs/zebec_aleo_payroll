import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

import { computeStreamFee, computeTopupAmount, computeWithdrawableAmount } from "../../sdk/math.js";

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

describe("computeTopupAmount", () => {
  const DURATION = 100n;
  const FULL = 10_000n; // 100 tokens per stream second
  const anchor = {
    duration: DURATION,
    paused: false,
    lastPausedTime: 0n,
    pausedInterval: 0n,
    coveredUntil: 1_050n, // covered through stream second 50
  };

  it("has no debt while stream time is within the covered window", () => {
    assert.deepEqual(computeTopupAmount(anchor, FULL, 1_050n, 0n), {
      debtAmount: 0n,
      topupAmount: 0n,
      extraSeconds: 0n,
    });
  });

  it("accrues debt for stream time beyond covered_until", () => {
    // 20 stream seconds past coverage at 100 tokens/sec.
    assert.deepEqual(computeTopupAmount(anchor, FULL, 1_070n, 0n), {
      debtAmount: 2_000n,
      topupAmount: 2_000n,
      extraSeconds: 0n,
    });
  });

  it("freezes debt while the stream is paused", () => {
    // Paused at t=1060 with 10s of banked pause: stream time is 1050 -> no debt
    // even though wall clock is far ahead.
    const paused = { ...anchor, paused: true, lastPausedTime: 1_060n, pausedInterval: 10n };
    assert.deepEqual(computeTopupAmount(paused, FULL, 9_999n, 0n), {
      debtAmount: 0n,
      topupAmount: 0n,
      extraSeconds: 0n,
    });
  });

  it("adds extra pre-payment and buys extra covered seconds", () => {
    // 500 extra tokens at 100 tokens/sec buy 5 extra seconds.
    assert.deepEqual(computeTopupAmount(anchor, FULL, 1_070n, 500n), {
      debtAmount: 2_000n,
      topupAmount: 2_500n,
      extraSeconds: 5n,
    });
  });

  it("throws on non-positive duration or full amount", () => {
    assert.throws(() => computeTopupAmount({ ...anchor, duration: 0n }, FULL, 1_000n, 0n));
    assert.throws(() => computeTopupAmount(anchor, 0n, 1_000n, 0n));
  });
});

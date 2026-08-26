import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

import {
  computeAutoWithdrawalFee,
  computeStreamFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  isWithdrawFrequencyValid,
} from "../../sdk/math.js";

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
  const START = 1_000n;
  const DURATION = 100n;
  const FULL = 10_000n; // 100 tokens per stream second
  const anchor = {
    startTime: START,
    duration: DURATION,
    paused: false,
    lastPausedTime: 0n,
    pausedInterval: 0n,
    depositedAmount: 3_000n, // covered through stream second 30
  };

  it("has no debt while the deposit covers the vested amount", () => {
    assert.deepEqual(
      computeTopupAmount({ ...anchor, depositedAmount: 5_000n }, FULL, 1_050n, 0n),
      { debtAmount: 0n, topupAmount: 0n, acceptedExtra: 0n },
    );
  });

  it("accrues the vested amount beyond the deposit as debt", () => {
    // Vested 5000 at t=1050 minus deposit 3000 -> 2000 debt.
    assert.deepEqual(computeTopupAmount(anchor, FULL, 1_050n, 0n), {
      debtAmount: 2_000n,
      topupAmount: 2_000n,
      acceptedExtra: 0n,
    });
  });

  it("caps total top-up so the deposit never exceeds the stream amount", () => {
    // Stream fully elapsed: vested = FULL; debt capped at FULL - deposit.
    assert.deepEqual(computeTopupAmount({ ...anchor, depositedAmount: 0n }, FULL, 9_999n, 0n), {
      debtAmount: FULL,
      topupAmount: FULL,
      acceptedExtra: 0n,
    });
  });

  it("freezes debt while the stream is paused", () => {
    // Paused at t=1060 with 10s of banked pause: stream time is 1050 -> same
    // debt even though the wall clock is far ahead.
    const paused = { ...anchor, paused: true, lastPausedTime: 1_060n, pausedInterval: 10n };
    assert.deepEqual(computeTopupAmount(paused, FULL, 9_999n, 0n), {
      debtAmount: 2_000n,
      topupAmount: 2_000n,
      acceptedExtra: 0n,
    });
  });

  it("adds extra pre-payment up to the remaining capacity", () => {
    // Deposit 9000 covers the vested 7000 at t=1070; capacity is 1000, so a
    // larger extra request is truncated to 1000.
    const funded = { ...anchor, depositedAmount: 9_000n };
    assert.deepEqual(computeTopupAmount(funded, FULL, 1_070n, 500n), {
      debtAmount: 0n,
      topupAmount: 500n,
      acceptedExtra: 500n,
    });
    assert.deepEqual(computeTopupAmount(funded, FULL, 1_070n, 2_000n), {
      debtAmount: 0n,
      topupAmount: 1_000n,
      acceptedExtra: 1_000n,
    });
  });

  it("throws on non-positive duration or full amount", () => {
    assert.throws(() => computeTopupAmount({ ...anchor, duration: 0n }, FULL, 1_000n, 0n));
    assert.throws(() => computeTopupAmount(anchor, 0n, 1_000n, 0n));
  });
});

describe("computeAutoWithdrawalFee", () => {
  it("multiplies before dividing like the on-chain helper", () => {
    // duration=90, frequency=60, base=100: floor(9000/60)=150 + platform 50.
    assert.equal(computeAutoWithdrawalFee(90n, 60n, 100n, 50n), 200n);
  });

  it("accounts for fractional transactions (unlike divide-first)", () => {
    // duration=61, frequency=60, base=60: multiply-first gives floor(3660/60)=61,
    // a divide-first implementation would give floor(61/60)*60 = 60.
    assert.equal(computeAutoWithdrawalFee(61n, 60n, 60n, 0n), 61n);
  });

  it("guards a zero frequency with the daily default", () => {
    assert.equal(computeAutoWithdrawalFee(86_400n, 0n, 1n, 7n), 8n);
  });

  it("rejects frequencies outside the on-chain whitelist", () => {
    assert.throws(() => computeAutoWithdrawalFee(100n, 61n, 1n, 0n));
  });

  it("throws on non-positive duration", () => {
    assert.throws(() => computeAutoWithdrawalFee(0n, 60n, 1n, 0n));
  });
});

describe("isWithdrawFrequencyValid", () => {
  it("accepts every on-chain WITHDRAW_FREQUENCIES entry", () => {
    for (const f of [60n, 120n, 3_600n, 43_200n, 86_400n, 604_800n, 1_209_600n, 2_592_000n, 7_776_000n, 15_552_000n, 31_536_000n]) {
      assert.equal(isWithdrawFrequencyValid(f), true, `${f}`);
    }
  });

  it("rejects other values", () => {
    assert.equal(isWithdrawFrequencyValid(61n), false);
    assert.equal(isWithdrawFrequencyValid(0n), false);
  });
});

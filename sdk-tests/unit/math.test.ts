import { strict as assert } from "node:assert";
import { describe, it } from "mocha";

import {
  computeAutoWithdrawalFee,
  computeStreamFee,
  computeTopupAmount,
  computeWithdrawableAmount,
  findFeeTier,
  isWithdrawFrequencyValid,
  nowSeconds,
  WITHDRAW_FREQUENCIES,
} from "../../sdk/math.js";

const ONE_USD = 1_000_000n; // $1.00 at 6 price decimals

describe("computeStreamFee", () => {
  it("computes usd value and fee like the on-chain function", () => {
    // 1 token at $1.00 -> $1.00 of value, first tier (25 bps).
    const { usdValue, streamFee } = computeStreamFee(1_000_000n, ONE_USD);
    assert.equal(usdValue, 1_000_000n); // $1.00
    assert.equal(streamFee, 2_500n); // 0.25% of one token
  });

  it("truncates like integer division", () => {
    const { usdValue, streamFee } = computeStreamFee(3n, ONE_USD);
    assert.equal(usdValue, 3n);
    assert.equal(streamFee, 0n); // floor(3 * 25 / 10000) = 0
  });
});

describe("computeStreamFee — tier boundaries", () => {
  it("switches tier exactly at the tier minimum (inclusive)", () => {
    // $3,000 (the tier-2 minimum) is charged 18 bps, one unit below it 25 bps.
    assert.equal(computeStreamFee(2_999_999_999n, ONE_USD).streamFee, 7_499_999n);
    assert.equal(computeStreamFee(3_000_000_000n, ONE_USD).streamFee, 5_400_000n);
    // $10,000 crosses into the 10 bps tier.
    assert.equal(computeStreamFee(9_999_999_999n, ONE_USD).streamFee, 17_999_999n);
    assert.equal(computeStreamFee(10_000_000_000n, ONE_USD).streamFee, 10_000_000n);
  });

  it("rejects a usd value above the on-chain u64 range", () => {
    // The on-chain fee math keeps the usd value in a u64; 2e19 exceeds it.
    assert.throws(
      () => computeStreamFee(20_000_000_000_000_000_000n, ONE_USD),
      /exceeds the u64 range/,
    );
  });

  it("has no tier for a zero-valued stream", () => {
    // The lowest tier starts at 1, so a zero usd value (zero amount, or a
    // dust amount at a low price) has no tier at all rather than a zero fee.
    assert.throws(() => computeStreamFee(0n, ONE_USD), /No fee tier found/);
    assert.throws(() => computeStreamFee(1n, 1n), /No fee tier found/);
  });

  it("has no tier for a zero token price", () => {
    // Guards the `feeUsd * SCALE / tokenPriceUsd` division by zero: the tier
    // lookup on the (zero) usd value fails first.
    assert.throws(() => computeStreamFee(1_000_000n, 0n), /No fee tier found/);
  });
});

describe("findFeeTier", () => {
  it("maps amounts to the tier that contains them", () => {
    assert.equal(findFeeTier(1n).feeBps, 25n);
    assert.equal(findFeeTier(2_999_999_999n).feeBps, 25n);
    assert.equal(findFeeTier(3_000_000_000n).feeBps, 18n);
    assert.equal(findFeeTier(9_999_999_999n).feeBps, 18n);
    assert.equal(findFeeTier(10_000_000_000n).feeBps, 10n);
  });

  it("has no tier below 1 or at the u128 ceiling", () => {
    // Both tier bounds are half-open [min, max), so u128::MAX itself is
    // uncovered — only reachable with a nonsensical price/amount pair.
    assert.throws(() => findFeeTier(0n), /No fee tier found/);
    assert.throws(() => findFeeTier((1n << 128n) - 1n), /No fee tier found/);
    assert.equal(findFeeTier((1n << 128n) - 2n).feeBps, 10n);
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

// ===========================================================================
// Edge cases derived from `src/main.leo`
// ===========================================================================

describe("computeWithdrawableAmount — boundaries", () => {
  const START = 1_000n;
  const DURATION = 100n;
  const FULL = 10_000n;

  it("vests nothing in the first second and everything at the last", () => {
    // `effective_now <= start_time` is the on-chain early return.
    assert.deepEqual(computeWithdrawableAmount(START, START, DURATION, 0n, FULL, 0n), {
      totalWithdrawable: 0n,
      currentlyWithdrawable: 0n,
    });
    // elapsed = 1 -> the first per-second slice.
    assert.equal(
      computeWithdrawableAmount(START + 1n, START, DURATION, 0n, FULL, 0n)
        .totalWithdrawable,
      100n,
    );
    // elapsed = duration - 1 -> everything but the last slice.
    assert.equal(
      computeWithdrawableAmount(START + DURATION - 1n, START, DURATION, 0n, FULL, 0n)
        .totalWithdrawable,
      9_900n,
    );
    // elapsed == duration is the `>=` branch: fully vested, exactly once.
    assert.equal(
      computeWithdrawableAmount(START + DURATION, START, DURATION, 0n, FULL, 0n)
        .totalWithdrawable,
      FULL,
    );
  });

  it("never vests more than the full amount past the end", () => {
    const far = computeWithdrawableAmount(START + DURATION * 100n, START, DURATION, 0n, FULL, 0n);
    assert.equal(far.totalWithdrawable, FULL);
    assert.equal(far.currentlyWithdrawable, FULL);
  });

  it("leaves nothing withdrawable once the full amount is drawn", () => {
    assert.deepEqual(
      computeWithdrawableAmount(START + DURATION, START, DURATION, 0n, FULL, FULL),
      { totalWithdrawable: FULL, currentlyWithdrawable: 0n },
    );
  });

  it("truncates sub-unit accrual to zero (dust streams)", () => {
    // 10 units over 3 seconds: after 1 second only floor(10/3) = 3 has vested.
    assert.equal(
      computeWithdrawableAmount(1n, 0n, 3n, 0n, 10n, 0n).totalWithdrawable,
      3n,
    );
    // 1 unit over 100 seconds: nothing vests for the first 99 seconds.
    assert.equal(
      computeWithdrawableAmount(99n, 0n, 100n, 0n, 1n, 0n).totalWithdrawable,
      0n,
    );
  });

  it("rejects an accrual below what was already withdrawn", () => {
    // Mirrors the on-chain `assert(total_withdrawable_amount >= withdrawn_amount)`,
    // which a caller could only trip with a forged anchor snapshot.
    assert.throws(
      () => computeWithdrawableAmount(1_050n, START, DURATION, 0n, FULL, 6_000n),
      /below the already withdrawn amount/,
    );
  });

  it("returns zero for a zero stream amount", () => {
    assert.deepEqual(computeWithdrawableAmount(1_050n, START, DURATION, 0n, 0n, 0n), {
      totalWithdrawable: 0n,
      currentlyWithdrawable: 0n,
    });
  });

  // The following two cases are states the chain cannot reach: the on-chain
  // math would halt on an unsigned underflow/overflow. The SDK mirror uses
  // arbitrary-precision bigints, so it returns a value instead — pinned here
  // so a future change to the mirror is a deliberate one.
  it("clamps to zero when the paused interval exceeds the elapsed time", () => {
    // On-chain `(now - start) - paused_interval` would underflow u64 and halt.
    assert.deepEqual(computeWithdrawableAmount(1_010n, START, DURATION, 20n, FULL, 0n), {
      totalWithdrawable: 0n,
      currentlyWithdrawable: 0n,
    });
  });

  it("goes negative when more than the full amount was withdrawn", () => {
    // On-chain `full_amount - withdrawn_amount` would underflow u128 and halt.
    assert.equal(
      computeWithdrawableAmount(START + DURATION, START, DURATION, 0n, FULL, FULL + 1n)
        .currentlyWithdrawable,
      -1n,
    );
  });
});

describe("computeTopupAmount — funding boundaries", () => {
  const START = 1_000n;
  const DURATION = 100n;
  const FULL = 10_000n;
  const anchor = {
    startTime: START,
    duration: DURATION,
    paused: false,
    lastPausedTime: 0n,
    pausedInterval: 0n,
    depositedAmount: 3_000n,
  };

  it("accepts nothing once the stream is fully funded", () => {
    // The on-chain entry then fails `assert(topup_amount > 0)`, so the SDK's
    // zero result is the signal not to submit the transaction at all.
    assert.deepEqual(
      computeTopupAmount({ ...anchor, depositedAmount: FULL }, FULL, 9_999n, 5_000n),
      { debtAmount: 0n, topupAmount: 0n, acceptedExtra: 0n },
    );
  });

  it("accepts nothing when the deposit already exceeds the stream amount", () => {
    assert.deepEqual(
      computeTopupAmount({ ...anchor, depositedAmount: FULL + 1n }, FULL, 9_999n, 5_000n),
      { debtAmount: 0n, topupAmount: 0n, acceptedExtra: 0n },
    );
  });

  it("has no debt before the stream starts, only pre-payment", () => {
    assert.deepEqual(computeTopupAmount(anchor, FULL, START - 1n, 500n), {
      debtAmount: 0n,
      topupAmount: 500n,
      acceptedExtra: 500n,
    });
  });

  it("accepts extra exactly equal to the remaining capacity", () => {
    // Capacity is FULL - deposited = 7000 with no debt yet (t = start).
    assert.deepEqual(computeTopupAmount(anchor, FULL, START, 7_000n), {
      debtAmount: 0n,
      topupAmount: 7_000n,
      acceptedExtra: 7_000n,
    });
  });

  it("caps debt plus extra at the total stream funding", () => {
    // Unfunded stream halfway through: 5000 of debt leaves 5000 of capacity,
    // so a 9999 extra request is truncated and the deposit lands on FULL.
    const empty = { ...anchor, depositedAmount: 0n };
    assert.deepEqual(computeTopupAmount(empty, FULL, 1_050n, 9_999n), {
      debtAmount: 5_000n,
      topupAmount: FULL,
      acceptedExtra: 5_000n,
    });
  });

  it("counts no debt while paused before the stream started", () => {
    const paused = { ...anchor, paused: true, lastPausedTime: START - 100n };
    assert.deepEqual(computeTopupAmount(paused, FULL, 9_999n, 0n), {
      debtAmount: 0n,
      topupAmount: 0n,
      acceptedExtra: 0n,
    });
  });

  it("ignores already-withdrawn amounts when sizing the debt", () => {
    // The on-chain call passes withdrawn = 0: debt tracks the vested total,
    // not the unwithdrawn remainder.
    assert.equal(computeTopupAmount(anchor, FULL, 1_100n, 0n).debtAmount, 7_000n);
  });
});

describe("computeAutoWithdrawalFee — boundaries", () => {
  it("charges one transaction per interval for every whitelisted frequency", () => {
    for (const frequency of WITHDRAW_FREQUENCIES) {
      assert.equal(
        computeAutoWithdrawalFee(frequency, frequency, 1_000n, 0n),
        1_000n,
        `${frequency}`,
      );
      assert.equal(
        computeAutoWithdrawalFee(frequency * 3n, frequency, 1_000n, 0n),
        3_000n,
        `${frequency}`,
      );
    }
  });

  it("charges only the platform fee for a stream shorter than one interval", () => {
    // floor(1 * 1 / 60) = 0 transactions.
    assert.equal(computeAutoWithdrawalFee(1n, 60n, 1n, 7n), 7n);
  });

  it("charges only the platform fee when the base fee is zero", () => {
    assert.equal(computeAutoWithdrawalFee(31_536_000n, 60n, 0n, 500n), 500n);
  });

  it("charges only the transaction fee when the platform fee is zero", () => {
    assert.equal(computeAutoWithdrawalFee(3_600n, 3_600n, 250n, 0n), 250n);
  });

  it("rejects near-miss frequencies", () => {
    for (const frequency of [30n, 59n, 86_401n, 2_592_001n, 31_535_999n]) {
      assert.throws(
        () => computeAutoWithdrawalFee(86_400n, frequency, 1n, 0n),
        /invalid withdraw frequency/,
        `${frequency}`,
      );
    }
  });
});

describe("WITHDRAW_FREQUENCIES", () => {
  it("matches the on-chain table exactly (length and order)", () => {
    // `WITHDRAW_FREQUENCIES_LEN` in main.leo is 11; the loop in
    // `is_withdraw_frequency_valid` walks this table in order.
    assert.equal(WITHDRAW_FREQUENCIES.length, 11);
    assert.deepEqual([...WITHDRAW_FREQUENCIES], [
      60n,
      60n * 2n,
      60n * 60n,
      60n * 60n * 12n,
      60n * 60n * 24n,
      60n * 60n * 24n * 7n,
      60n * 60n * 24n * 14n,
      60n * 60n * 24n * 30n,
      60n * 60n * 24n * 30n * 3n,
      60n * 60n * 24n * 30n * 6n,
      60n * 60n * 24n * 365n,
    ]);
  });
});

describe("nowSeconds", () => {
  it("returns whole unix seconds", () => {
    const now = nowSeconds();
    const expected = BigInt(Math.floor(Date.now() / 1000));
    assert.ok(now === expected || now === expected - 1n, `${now} vs ${expected}`);
  });
});

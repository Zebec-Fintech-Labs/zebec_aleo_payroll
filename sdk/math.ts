/**
 * BigInt mirrors of the pure helper functions at the bottom of
 * `src/main.leo` (`compute_stream_fee`, `compute_withdrawable_amount`), so
 * SDK users can preview fees and withdrawable amounts off-chain.
 */

import type { RawStreamAnchor } from "./types.js";

/** @deprecated Legacy TokenPrice-era constant; the on-chain program no longer
 * uses USD price feeds. Stream fees are admin-signed via `StreamTokenFee`. */
export const USD_PRICE_DECIMALS_SCALE = 1_000_000n;
/** @deprecated Legacy TokenPrice-era constant; see {@link USD_PRICE_DECIMALS_SCALE}. */
export const BPS_DENOMINATOR = 10_000n;
/** @deprecated Legacy TokenPrice-era constant; see {@link USD_PRICE_DECIMALS_SCALE}. */
export const DEFAULT_FEE_BPS = 25n;
const U64_MAX = (1n << 64n) - 1n;

export interface StreamFee {
  /** USD value of the stream amount (6 decimals). */
  usdValue: bigint;
  /** Stream fee in microcredits. */
  streamFee: bigint;
}

/**
 * Mirror of the removed on-chain `compute_stream_fee` helper.
 * @deprecated The stream fee is now an admin-signed `StreamTokenFee`
 * (`stream_fee_amount` in microcredits); use it directly instead.
 */
export function computeStreamFee(
  amount: bigint,
  tokenPriceUsd: bigint,
  aleoPriceUsd: bigint,
  feeBps: bigint,
): StreamFee {
  const usdValue = (amount * tokenPriceUsd) / USD_PRICE_DECIMALS_SCALE;
  const feeUsd = (usdValue * feeBps) / BPS_DENOMINATOR;
  const streamFee = (feeUsd * USD_PRICE_DECIMALS_SCALE) / aleoPriceUsd;
  // The on-chain function asserts both results fit in u64.
  if (usdValue > U64_MAX || streamFee > U64_MAX) {
    throw new Error("fee computation exceeds the u64 range");
  }
  return { usdValue, streamFee };
}

export interface WithdrawableAmounts {
  /** Total amount vested up to `effectiveNow`. */
  totalWithdrawable: bigint;
  /** Amount that can be withdrawn right now (total minus already withdrawn). */
  currentlyWithdrawable: bigint;
}

/** Mirror of `compute_withdrawable_amount` in `main.leo`. */
export function computeWithdrawableAmount(
  effectiveNow: bigint,
  startTime: bigint,
  duration: bigint,
  pausedInterval: bigint,
  fullAmount: bigint,
  withdrawnAmount: bigint,
): WithdrawableAmounts {
  if (duration <= 0n) {
    throw new Error("duration must be positive");
  }
  if (effectiveNow <= startTime) {
    return { totalWithdrawable: 0n, currentlyWithdrawable: 0n };
  }
  const elapsed = effectiveNow - startTime - pausedInterval;
  if (elapsed <= 0n) {
    return { totalWithdrawable: 0n, currentlyWithdrawable: 0n };
  }
  if (elapsed >= duration) {
    return {
      totalWithdrawable: fullAmount,
      currentlyWithdrawable: fullAmount - withdrawnAmount,
    };
  }
  const totalWithdrawable = (elapsed * fullAmount) / duration;
  if (totalWithdrawable < withdrawnAmount) {
    throw new Error("computed total withdrawable is below the already withdrawn amount");
  }
  return {
    totalWithdrawable,
    currentlyWithdrawable: totalWithdrawable - withdrawnAmount,
  };
}

export interface TopupAmount {
  /** Accrued debt in token units: vested amount not yet deposited. */
  debtAmount: bigint;
  /** Total amount to transfer: `debtAmount + acceptedExtra`. */
  topupAmount: bigint;
  /**
   * Portion of the requested `extra` that was accepted after the debt, capped
   * so the combined deposit cannot exceed the stream total.
   */
  acceptedExtra: bigint;
}

/**
 * Mirror of the pause-aware debt math in `topup_stream_private` /
 * `topup_stream_public` in `main.leo`. Debt is the vested amount (withdrawn
 * amounts excluded) exceeding the deposited amount; extra pre-payment is
 * capped so `deposited_amount + topup <= full_amount`.
 */
export function computeTopupAmount(
  anchor: Pick<
    RawStreamAnchor,
    | "startTime"
    | "duration"
    | "paused"
    | "lastPausedTime"
    | "pausedInterval"
    | "depositedAmount"
  >,
  fullAmount: bigint,
  now: bigint,
  extra: bigint,
): TopupAmount {
  if (anchor.duration <= 0n) {
    throw new Error("duration must be positive");
  }
  if (fullAmount <= 0n) {
    throw new Error("full amount must be positive");
  }
  const effectiveTime = anchor.paused ? anchor.lastPausedTime : now;
  const { totalWithdrawable: vestedAmount } = computeWithdrawableAmount(
    effectiveTime,
    anchor.startTime,
    anchor.duration,
    anchor.pausedInterval,
    fullAmount,
    0n,
  );
  const maxPossibleTopup =
    anchor.depositedAmount < fullAmount
      ? fullAmount - anchor.depositedAmount
      : 0n;
  const calculatedDebt = vestedAmount > anchor.depositedAmount
    ? vestedAmount - anchor.depositedAmount
    : 0n;
  const debtAmount = calculatedDebt < maxPossibleTopup
    ? calculatedDebt
    : maxPossibleTopup;
  const remainingCapacity = maxPossibleTopup - debtAmount;
  const acceptedExtra = extra < remainingCapacity ? extra : remainingCapacity;
  return {
    debtAmount,
    topupAmount: debtAmount + acceptedExtra,
    acceptedExtra,
  };
}

/** Current unix timestamp in seconds, as `bigint` (Leo `i64`). */
export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

// ===========================================================================
// Mirrors of the pure helpers in `src/main.leo` (fee / coverage / validation)
// ===========================================================================

/**
 * Withdraw frequencies accepted by the on-chain `is_withdraw_frequency_valid`
 * assert (see `WITHDRAW_FREQUENCIES` in `main.leo`).
 */
export const WITHDRAW_FREQUENCIES: readonly bigint[] = [
  60n, // per minute
  120n, // per 2 minutes
  3_600n, // hourly
  43_200n, // per half day
  86_400n, // daily
  604_800n, // weekly
  1_209_600n, // bi-weekly
  2_592_000n, // monthly
  7_776_000n, // quarterly
  15_552_000n, // half-yearly
  31_536_000n, // yearly
];

/** Mirror of `is_withdraw_frequency_valid` in `main.leo`. */
export function isWithdrawFrequencyValid(withdrawFrequency: bigint): boolean {
  return WITHDRAW_FREQUENCIES.includes(withdrawFrequency);
}

/**
 * Mirror of `compute_auto_withdrawal_fee` in `main.leo`: the total
 * auto-withdrawal fee in microcredits for a stream.
 *
 * The on-chain program multiplies before dividing so fractional
 * `(duration / frequency)` transactions are accounted for; this mirror keeps
 * the same order of operations — using a different order can understate the
 * fee and make the credit-record coverage assert fail during proving.
 *
 * When auto-withdrawal is disabled the caller may pass `withdrawFrequency = 0`;
 * like the on-chain entries, a zero frequency is replaced with the daily
 * default (the result is multiplied by zero anyway).
 */
export function computeAutoWithdrawalFee(
  duration: bigint,
  withdrawFrequency: bigint,
  baseFee: bigint,
  platformFee: bigint,
): bigint {
  const safeFrequency =
    withdrawFrequency > 0n ? withdrawFrequency : DEFAULT_WITHDRAW_FREQUENCY;
  if (!isWithdrawFrequencyValid(safeFrequency)) {
    throw new Error(`invalid withdraw frequency: ${withdrawFrequency}`);
  }
  if (duration <= 0n) {
    throw new Error("duration must be positive");
  }
  return platformFee + (duration * baseFee) / safeFrequency;
}

/** Daily fallback used by the on-chain program to guard division by zero. */
export const DEFAULT_WITHDRAW_FREQUENCY = 86_400n;

/**
 * @deprecated Legacy constant from when `create_stream_private` split the
 * credit record (the split burned 10,000 microcredits). The program now pays
 * the auto-withdrawal fee with a direct `credits.aleo::transfer_private` and
 * the stream fee in the streaming token, so no split burn applies.
 */
export const SPLIT_FEE = 10_000n;

/**
 * BigInt mirrors of the pure helper functions at the bottom of
 * `src/main.leo` (`compute_stream_fee`, `compute_withdrawable_amount`), so
 * SDK users can preview fees and withdrawable amounts off-chain.
 */

export const USD_PRICE_DECIMALS_SCALE = 1_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const MAX_FEE_TIERS = 8;
const U64_MAX = (1n << 64n) - 1n;

export interface StreamFee {
  /** USD value of the stream amount (6 decimals). */
  usdValue: bigint;
  /** Stream fee in microcredits. */
  streamFee: bigint;
}

/** Mirror of `compute_stream_fee` in `main.leo`. */
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

/** Current unix timestamp in seconds, as `bigint` (Leo `i64`). */
export function nowSeconds(): bigint {
  return BigInt(Math.floor(Date.now() / 1000));
}

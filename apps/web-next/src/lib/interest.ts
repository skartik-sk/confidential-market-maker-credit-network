/**
 * Linear interest accrual for credit lines, denominated in slots.
 *
 * The chain only exposes slot counters (no wall-clock timestamps), so accrual
 * is computed from the slot delta between the line's `openedSlot` and the
 * current slot:
 *
 *   interest = principal × (interestBps / 10_000) × (elapsedSlots / (slotsPerSecond × secondsPerYear))
 *
 * Solana runs at ≈ 2.5 slots/sec (devnet fluctuates; this is the standard
 * planning figure). 31,536,000 seconds = 365 days.
 */

/** Default chain throughput used when none is supplied. */
export const DEFAULT_SLOTS_PER_SECOND = 2.5;

/** Seconds in a 365-day year. */
const SECONDS_PER_YEAR = 31_536_000;

export function accruedInterestUsd(params: {
  principalUsd: number;
  interestBps: number;
  openedSlot: number;
  currentSlot: number;
  /** Chain throughput in slots/second — defaults to Solana's ≈ 2.5. */
  slotsPerSecond?: number;
}): number {
  const { principalUsd, interestBps, openedSlot, currentSlot } = params;
  const slotsPerSecond = params.slotsPerSecond ?? DEFAULT_SLOTS_PER_SECOND;

  // Degenerate inputs (bad RPC data, divide-by-zero) accrue nothing.
  if (
    !Number.isFinite(principalUsd) ||
    !Number.isFinite(interestBps) ||
    !Number.isFinite(openedSlot) ||
    !Number.isFinite(currentSlot) ||
    !Number.isFinite(slotsPerSecond) ||
    slotsPerSecond <= 0
  ) {
    return 0;
  }

  // Clamp negative elapsed (stale slot samples / clock skew) to zero.
  const elapsedSlots = Math.max(0, currentSlot - openedSlot);

  const yearFraction = elapsedSlots / (slotsPerSecond * SECONDS_PER_YEAR);
  const interest = principalUsd * (interestBps / 10_000) * yearFraction;

  return Math.round(interest * 100) / 100;
}

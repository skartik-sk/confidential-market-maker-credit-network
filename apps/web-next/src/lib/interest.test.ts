/**
 * Interest accrual tests:
 *   1. Zero elapsed slots → no interest.
 *   2. Exactly one year → principal × bps/10_000 (±0.01).
 *   3. Half a year → exactly half the annual interest.
 *   4. Negative elapsed (stale slot) clamps to 0.
 */

import { describe, test, expect } from "bun:test";
import { accruedInterestUsd, DEFAULT_SLOTS_PER_SECOND } from "./interest";

const SECONDS_PER_YEAR = 31_536_000;

describe("accruedInterestUsd", () => {
  test("zero elapsed slots → 0", () => {
    expect(
      accruedInterestUsd({
        principalUsd: 10_000,
        interestBps: 75,
        openedSlot: 50_000,
        currentSlot: 50_000,
      }),
    ).toBe(0);
  });

  test("exactly one year → principal × bps/10000 (±0.01)", () => {
    const oneYearSlots = DEFAULT_SLOTS_PER_SECOND * SECONDS_PER_YEAR; // 78,840,000
    const got = accruedInterestUsd({
      principalUsd: 10_000,
      interestBps: 75,
      openedSlot: 0,
      currentSlot: oneYearSlots,
    });
    const expected = 10_000 * (75 / 10_000); // 75.00
    expect(Math.abs(got - expected)).toBeLessThan(0.01);
    expect(got).toBeCloseTo(expected, 2);
  });

  test("half a year → half the annual interest", () => {
    const halfYearSlots = (DEFAULT_SLOTS_PER_SECOND * SECONDS_PER_YEAR) / 2;
    const got = accruedInterestUsd({
      principalUsd: 10_000,
      interestBps: 75,
      openedSlot: 12_345,
      currentSlot: 12_345 + halfYearSlots,
    });
    expect(got).toBeCloseTo(37.5, 2);
  });

  test("negative elapsed (stale slot) clamps to 0", () => {
    expect(
      accruedInterestUsd({
        principalUsd: 10_000,
        interestBps: 75,
        openedSlot: 100_000,
        currentSlot: 99_999,
      }),
    ).toBe(0);
  });

  test("custom slotsPerSecond scales the accrual window", () => {
    // 1 slot/sec → a year is 31,536,000 slots; full annual interest applies.
    const got = accruedInterestUsd({
      principalUsd: 50_000,
      interestBps: 100,
      openedSlot: 0,
      currentSlot: SECONDS_PER_YEAR,
      slotsPerSecond: 1,
    });
    expect(got).toBeCloseTo(500, 2);
  });

  test("result is rounded to 2 decimal places", () => {
    // 0.001 of a year on $1,000 @ 75 bps → raw 0.0075, rounds to 0.01.
    const got = accruedInterestUsd({
      principalUsd: 1_000,
      interestBps: 75,
      openedSlot: 0,
      currentSlot: DEFAULT_SLOTS_PER_SECOND * SECONDS_PER_YEAR / 1_000,
    });
    expect(got).toBe(0.01);
  });

  test("non-finite or degenerate inputs accrue nothing", () => {
    expect(
      accruedInterestUsd({ principalUsd: NaN, interestBps: 75, openedSlot: 0, currentSlot: 100 }),
    ).toBe(0);
    expect(
      accruedInterestUsd({ principalUsd: 1_000, interestBps: 75, openedSlot: 0, currentSlot: 100, slotsPerSecond: 0 }),
    ).toBe(0);
  });
});

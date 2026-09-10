/**
 * Tests for src/lib/api-guard.ts
 * Run: bun test src/lib/api-guard.test.ts
 */

import { describe, test, expect } from "bun:test";
import {
  checkRateLimit,
  clientKey,
  rateLimitRequest,
  requireAddress,
  cleanStr,
} from "./api-guard";
import type { NextRequest } from "next/server";

const PROGRAM_ID = "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5"; // 44 chars, base58

function fakeRequest(headers: Record<string, string> = {}): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}

function uniqueKey(tag: string): string {
  return `${tag}:${Math.random().toString(36).slice(2)}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("checkRateLimit", () => {
  test("allows up to the limit, then blocks within the window", () => {
    const key = uniqueKey("rl-basic");
    expect(checkRateLimit(key, 3, 60_000)).toBe(true);
    expect(checkRateLimit(key, 3, 60_000)).toBe(true);
    expect(checkRateLimit(key, 3, 60_000)).toBe(true);
    expect(checkRateLimit(key, 3, 60_000)).toBe(false);
    expect(checkRateLimit(key, 3, 60_000)).toBe(false);
  });

  test("keys are independent", () => {
    const a = uniqueKey("rl-a");
    const b = uniqueKey("rl-b");
    expect(checkRateLimit(a, 1, 60_000)).toBe(true);
    expect(checkRateLimit(a, 1, 60_000)).toBe(false);
    expect(checkRateLimit(b, 1, 60_000)).toBe(true);
  });

  test("sliding window lets hits through again after expiry", async () => {
    const key = uniqueKey("rl-window");
    expect(checkRateLimit(key, 1, 40)).toBe(true);
    expect(checkRateLimit(key, 1, 40)).toBe(false);
    await sleep(60); // past the 40ms window
    expect(checkRateLimit(key, 1, 40)).toBe(true);
  });

  test("expired hits do not count against newer hits", async () => {
    const key = uniqueKey("rl-slide");
    expect(checkRateLimit(key, 2, 40)).toBe(true);
    await sleep(60);
    expect(checkRateLimit(key, 2, 40)).toBe(true); // first hit expired
    expect(checkRateLimit(key, 2, 40)).toBe(true);
    expect(checkRateLimit(key, 2, 40)).toBe(false); // two fresh hits recorded
  });
});

describe("clientKey", () => {
  test("uses the first x-forwarded-for hop", () => {
    const req = fakeRequest({ "x-forwarded-for": "203.0.113.7, 70.41.3.18" });
    expect(clientKey(req)).toBe("203.0.113.7");
  });

  test("trims whitespace around the forwarded value", () => {
    const req = fakeRequest({ "x-forwarded-for": "  198.51.100.2 " });
    expect(clientKey(req)).toBe("198.51.100.2");
  });

  test('falls back to "local" without the header', () => {
    expect(clientKey(fakeRequest())).toBe("local");
    expect(clientKey(fakeRequest({ "x-forwarded-for": "" }))).toBe("local");
  });
});

describe("rateLimitRequest", () => {
  test("GET and POST buckets are separate", () => {
    const req = fakeRequest({ "x-forwarded-for": `10.0.0.${Math.ceil(Math.random() * 250)}` });
    expect(rateLimitRequest(req, "GET")).toBe(true);
    expect(rateLimitRequest(req, "POST")).toBe(true);
  });

  test("blocks after the POST budget is exhausted", () => {
    const req = fakeRequest({ "x-forwarded-for": `10.1.0.${Math.ceil(Math.random() * 250)}` });
    for (let i = 0; i < 30; i++) {
      expect(rateLimitRequest(req, "POST")).toBe(true);
    }
    expect(rateLimitRequest(req, "POST")).toBe(false);
    expect(rateLimitRequest(req, "GET")).toBe(true); // GET bucket unaffected
  });
});

describe("requireAddress", () => {
  test("accepts a real program-id-style base58 address", () => {
    expect(requireAddress(PROGRAM_ID)).toBe(PROGRAM_ID);
    expect(requireAddress("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr")).toBe(
      "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
    );
  });

  test("trims surrounding whitespace", () => {
    expect(requireAddress(`  ${PROGRAM_ID}  `)).toBe(PROGRAM_ID);
  });

  test("accepts the 32-char minimum", () => {
    const min = "11111111111111111111111111111111"; // System Program, 32 chars of '1'
    expect(requireAddress(min)).toBe(min);
  });

  test("rejects too-short and too-long values", () => {
    expect(requireAddress("a".repeat(31))).toBeNull();
    expect(requireAddress("a".repeat(45))).toBeNull();
    expect(requireAddress("")).toBeNull();
  });

  test("rejects non-base58 characters (0, O, I, l)", () => {
    expect(requireAddress("0".repeat(44))).toBeNull();
    expect(requireAddress(`${"O".repeat(44)}`)).toBeNull();
    expect(requireAddress(`${"I".repeat(44)}`)).toBeNull();
    expect(requireAddress(`${"l".repeat(44)}`)).toBeNull();
    expect(requireAddress(`${PROGRAM_ID}$drop`)).toBeNull();
  });

  test("rejects non-string input", () => {
    expect(requireAddress(undefined)).toBeNull();
    expect(requireAddress(null)).toBeNull();
    expect(requireAddress(12345)).toBeNull();
    expect(requireAddress({})).toBeNull();
  });
});

describe("cleanStr", () => {
  test("trims and preserves short strings", () => {
    expect(cleanStr("  hello world  ", 64)).toBe("hello world");
  });

  test("truncates to maxLen", () => {
    expect(cleanStr("abcdefghij", 4)).toBe("abcd");
    expect(cleanStr("x".repeat(500), 64)).toHaveLength(64);
  });

  test("returns empty string for non-string input", () => {
    expect(cleanStr(undefined, 10)).toBe("");
    expect(cleanStr(null, 10)).toBe("");
    expect(cleanStr(42, 10)).toBe("");
    expect(cleanStr({ evil: true }, 10)).toBe("");
  });
});

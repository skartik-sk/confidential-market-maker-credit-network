/**
 * Shared API guard for the /api/exchange routes.
 *
 * Provides sliding-window rate limiting (per client IP), client-key
 * extraction, and strict input validation helpers for untrusted request
 * bodies/query params. The rate-limit state is module-scoped — matching the
 * in-memory exchange-store; a multi-instance deployment would swap this for
 * a shared store.
 */

import type { NextRequest } from "next/server";

/* ------------------------------------------------------------------ */
/*  Rate limiting (sliding window)                                     */
/* ------------------------------------------------------------------ */

/** key -> timestamps (ms) of accepted hits inside the current window. */
const rateBuckets = new Map<string, number[]>();

let lastSweep = 0;

/** Drop expired timestamps; forget idle keys so the Map cannot grow forever. */
function sweep(now: number, windowMs: number): void {
  for (const [key, hits] of rateBuckets) {
    const alive = hits.filter((t) => now - t < windowMs);
    if (alive.length === 0) rateBuckets.delete(key);
    else rateBuckets.set(key, alive);
  }
  lastSweep = now;
}

/**
 * Sliding-window rate limiter. Records a hit for `key` and returns whether
 * it is allowed (fewer than `limit` hits in the last `windowMs`).
 */
export function checkRateLimit(key: string, limit = 30, windowMs = 60_000): boolean {
  const now = Date.now();
  if (now - lastSweep >= windowMs) sweep(now, windowMs);

  const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return true;
}

/** Rate-limit presets used by the exchange routes (keyed per client+method). */
export const RATE_LIMITS = { get: 120, post: 30 } as const;
export const RATE_WINDOW_MS = 60_000;

/**
 * Convenience wrapper for route handlers: limits GETs to 120/min and POSTs
 * to 30/min per client key.
 */
export function rateLimitRequest(request: NextRequest, method: "GET" | "POST"): boolean {
  const limit = method === "GET" ? RATE_LIMITS.get : RATE_LIMITS.post;
  return checkRateLimit(`${clientKey(request)}:${method}`, limit, RATE_WINDOW_MS);
}

/* ------------------------------------------------------------------ */
/*  Client identification                                              */
/* ------------------------------------------------------------------ */

/** Best-effort client identity: first hop of x-forwarded-for, else "local". */
export function clientKey(request: NextRequest): string {
  const fwd = request.headers.get("x-forwarded-for");
  if (fwd) {
    const first = fwd.split(",")[0]?.trim();
    if (first) return first;
  }
  return "local";
}

/* ------------------------------------------------------------------ */
/*  Input validation                                                   */
/* ------------------------------------------------------------------ */

/** Base58 (Bitcoin/alphabet) charset — no 0, O, I, l. */
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;

/**
 * Validate a Solana address: trimmed, 32-44 chars, base58 charset only.
 * Returns the trimmed address, or null when invalid.
 */
export function requireAddress(v: unknown): string | null {
  const s = typeof v === "string" ? v.trim() : "";
  if (s.length < 32 || s.length > 44) return null;
  if (!BASE58_RE.test(s)) return null;
  return s;
}

/** Coerce an untrusted string: must be a string, trimmed, capped at maxLen. */
export function cleanStr(v: unknown, maxLen: number): string {
  if (typeof v !== "string") return "";
  return v.trim().slice(0, maxLen);
}

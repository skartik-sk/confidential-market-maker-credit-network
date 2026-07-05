# Live price WebSocket + instant buy/sell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Mute exchange stream real-time prices continuously via a client-side multi-source WebSocket manager (Binance → Coinbase → CoinGecko fallback), and make buy/sell feel instant via optimistic UI.

**Architecture:** A new browser-only singleton `PriceStream` opens Binance's combined ticker stream first; if it fails (e.g. US geo-block) it opens Coinbase's public Exchange feed for majors, and always polls the existing CoinGecko REST route every 30s as the long-tail + safety net. Pure parsing/arbiter/throttle logic lives in a separate dependency-free module so it is unit-testable. The exchange page consumes a `usePriceStream()` hook for live prices (replacing the 6s REST poll) and applies optimistic updates to buy/sell.

**Tech Stack:** TypeScript, React 19, Next.js 16.2.6 (App Router, client component only), Tailwind v4, `bun:test` for unit tests, browser `WebSocket` API. No new npm dependencies.

## Global Constraints

- **No new runtime dependencies.** Use the browser's native `WebSocket`, `fetch`, `setInterval`, `setTimeout`, and React 19 hooks only. Do NOT add packages.
- **No API keys, no server.** All price sockets are public and opened client-side. Do not add a WebSocket server (Vercel can't host one).
- **Provider endpoints (verbatim):**
  - Binance: `wss://stream.binance.com:9443/stream?streams=<sym>@ticker/…` where `<sym>` is lowercase, e.g. `solusdt`. Parse fields `s` (symbol), `c` (last price), `P` (24h change %).
  - Coinbase: `wss://ws-feed.exchange.coinbase.com`. Send `{ "type":"subscribe", "channels":[{ "name":"ticker", "product_ids":[...] }] }` within 5s of open. Parse `type==="ticker"`, `product_id`, `price`, `open_24h`.
  - CoinGecko fallback: reuse existing `GET /api/exchange/markets` (returns `markets[].spotPriceUsd`, `spotChange24hPct`, `asset`).
- **Asset set (matches `apps/web-next/src/lib/price-feed.ts:16-29`):** SOL, ETH, BTC, USDC, JUP, BONK, WIF, RAY, ORCA, PYTH, HNT, JTO.
- **Next.js 16.2.6 caveat (from `apps/web-next/AGENTS.md`):** this version may differ from training data. The changes here touch only a `"use client"` component and pure TS lib files — no server/routing APIs. If any Next API beyond `useEffect`/client `fetch` is needed, consult `apps/web-next/node_modules/next/dist/docs/` first.
- **Test runner:** `bun test` (Bun 1.3.10). Tests import relatively (e.g. `./price-stream-core`), never via the `@/` alias, so they resolve under `bun test`.
- **Keep `next build` green:** `apps/web-next/tsconfig.json` must exclude `*.test.ts` (added in Task 1) because `bun:test` types are not installed for the web app.
- **DRY / YAGNI:** Do not rewrite on-chain settlement, note-vault, CoinGecko OHLC, or exchange-store. Do not add user accounts/persistence.

---

## File Structure

- **Create** `apps/web-next/src/lib/price-stream-core.ts` — pure helpers (no browser globals): types, asset→symbol maps, `parseBinanceTicker`, `parseCoinbaseTicker`, `isStale`, `pickPrice`, `makeThrottler`. Fully unit-testable.
- **Create** `apps/web-next/src/lib/price-stream-core.test.ts` — `bun:test` unit tests for the core helpers.
- **Create** `apps/web-next/src/lib/price-stream.ts` — the side-effectful `PriceStream` manager (opens sockets, polls REST, exposes `usePriceStream()` hook + singleton).
- **Create** `apps/web-next/src/lib/price-stream.test.ts` — one integration-style test for the Binance→Coinbase fallback using injected fake sockets.
- **Modify** `apps/web-next/tsconfig.json` — exclude `*.test.ts` from Next's type-check.
- **Modify** `apps/web-next/src/app/exchange/page.tsx` — consume the stream for live prices, live chart edge, status chip, optimistic buy/sell, clearer confirmations.

---

## Task 1: Pure price-stream core + tests

**Files:**
- Create: `apps/web-next/src/lib/price-stream-core.ts`
- Create: `apps/web-next/src/lib/price-stream-core.test.ts`
- Modify: `apps/web-next/tsconfig.json` (add test exclude)

**Interfaces:**
- Consumes: nothing (dependency-free).
- Produces: `PriceSource`, `StreamPrice`, `BINANCE_SYMBOL`, `COINBASE_PRODUCT`, `ALL_ASSETS`, `STALE_MS`, `parseBinanceTicker(raw)`, `parseCoinbaseTicker(raw)`, `isStale(ts, now, staleMs?)`, `pickPrice(asset, candidates, now)`, `makeThrottler<T>(intervalMs, cb, now)`.

- [ ] **Step 1: Exclude tests from Next's tsconfig so `next build` stays green**

Modify `apps/web-next/tsconfig.json` — replace the `"exclude": ["node_modules"]` line:

```json
  "exclude": ["node_modules", "**/*.test.ts", "**/*.test.tsx"]
```

- [ ] **Step 2: Write the failing tests**

Create `apps/web-next/src/lib/price-stream-core.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  BINANCE_SYMBOL,
  COINBASE_PRODUCT,
  ALL_ASSETS,
  parseBinanceTicker,
  parseCoinbaseTicker,
  isStale,
  pickPrice,
  makeThrottler,
  type StreamPrice,
} from "./price-stream-core";

describe("price-stream-core", () => {
  test("asset maps cover the full asset set", () => {
    expect(ALL_ASSETS).toEqual(
      expect.arrayContaining(["SOL", "ETH", "BTC", "USDC", "JUP", "BONK", "WIF", "RAY", "ORCA", "PYTH", "HNT", "JTO"]),
    );
    expect(BINANCE_SYMBOL.SOL).toBe("solusdt");
    expect(COINBASE_PRODUCT.SOL).toBe("SOL-USD");
  });

  test("parseBinanceTicker reads a combined-stream frame", () => {
    const frame = {
      stream: "solusdt@ticker",
      data: { e: "24hrTicker", s: "SOLUSDT", c: "151.20", P: "2.34" },
    };
    expect(parseBinanceTicker(frame)).toEqual({ asset: "SOL", usd: 151.2, change24hPct: 2.34 });
  });

  test("parseBinanceTicker accepts a raw (unwrapped) frame and ignores bad prices", () => {
    expect(parseBinanceTicker({ s: "BTCUSDT", c: "60000", P: "-1.2" })).toEqual({
      asset: "BTC", usd: 60000, change24hPct: -1.2,
    });
    expect(parseBinanceTicker({ s: "SOLUSDT", c: "0", P: "1" })).toBeNull();
    expect(parseBinanceTicker({ s: "GARBAGEUSDT", c: "1" })).toBeNull();
    expect(parseBinanceTicker(null)).toBeNull();
  });

  test("parseCoinbaseTicker reads a ticker message and derives 24h change", () => {
    const msg = { type: "ticker", product_id: "ETH-USD", price: "3200", open_24h: "3000" };
    expect(parseCoinbaseTicker(msg)).toEqual({ asset: "ETH", usd: 3200, change24hPct: ((3200 - 3000) / 3000) * 100 });
  });

  test("parseCoinbaseTicker rejects non-ticker / unknown products", () => {
    expect(parseCoinbaseTicker({ type: "subscriptions", product_id: "ETH-USD" })).toBeNull();
    expect(parseCoinbaseTicker({ type: "ticker", product_id: "DOGE-USD", price: "0.1" })).toBeNull();
    expect(parseCoinbaseTicker({ type: "ticker", product_id: "SOL-USD", price: "nope" })).toBeNull();
  });

  test("isStale honours the threshold", () => {
    expect(isStale(1000, 1000 + 29_000)).toBe(false);
    expect(isStale(1000, 1000 + 31_000)).toBe(true);
  });

  test("pickPrice prefers fresh Binance, then Coinbase, then CoinGecko, then stale", () => {
    const now = 10_000;
    const binance: StreamPrice = { usd: 150, change24hPct: 1, source: "binance", ts: 9_500 };
    const coinbase: StreamPrice = { usd: 151, change24hPct: 1, source: "coinbase", ts: 9_500 };
    expect(pickPrice("SOL", { binance, coinbase }, now)?.source).toBe("binance");
    expect(pickPrice("SOL", { coinbase }, now)?.source).toBe("coinbase");

    // Binance stale -> fall through to fresh coinbase
    const staleBinance: StreamPrice = { ...binance, ts: 0 };
    expect(pickPrice("SOL", { binance: staleBinance, coinbase }, now)?.source).toBe("coinbase");

    // All fresh sources absent, only stale coinbase -> returns stale coinbase (best effort)
    expect(pickPrice("SOL", { coinbase: staleBinance }, now)?.source).toBe("coinbase");

    // Nothing at all
    expect(pickPrice("SOL", {}, now)).toBeNull();
  });

  test("makeThrottler emits at most once per interval (leading edge, drops the rest)", () => {
    let now = 0;
    const emitted: number[] = [];
    const push = makeThrottler<number>(100, (v) => emitted.push(v), () => now);
    push(1); // t=0   -> emits 1
    now = 50; push(2); // dropped
    now = 99; push(3); // dropped
    now = 100; push(4); // emits 4
    now = 250; push(5); // emits 5
    expect(emitted).toEqual([1, 4, 5]);
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test apps/web-next/src/lib/price-stream-core.test.ts`
Expected: FAIL — error resolving `./price-stream-core` ("module not found").

- [ ] **Step 4: Write the core implementation**

Create `apps/web-next/src/lib/price-stream-core.ts`:

```ts
/**
 * Pure helpers for the live price stream.
 *
 * No browser globals live here — this module is importable anywhere
 * (server route handlers, unit tests, client components). The
 * side-effectful WebSocket manager lives in price-stream.ts.
 */

export type PriceSource = "binance" | "coinbase" | "coingecko";

export interface StreamPrice {
  /** Spot price in USD. */
  usd: number;
  /** 24h percent change, e.g. +2.34. */
  change24hPct: number;
  /** Which source produced this value. */
  source: PriceSource;
  /** Epoch ms of the tick that produced this value. */
  ts: number;
}

/* Asset → exchange symbol maps ------------------------------------- */

// Binance market data uses lowercase concatenation with USDT.
export const BINANCE_SYMBOL: Record<string, string> = {
  SOL: "solusdt", ETH: "ethusdt", BTC: "btcusdt", USDC: "usdcusdt",
  JUP: "jupusdt", BONK: "bonkusdt", WIF: "wifusdt", RAY: "rayusdt",
  ORCA: "orcausdt", PYTH: "pythusdt", HNT: "hntusdt", JTO: "jtousdt",
};

// Coinbase Exchange product ids (majors only — Coinbase lists few alts).
export const COINBASE_PRODUCT: Record<string, string> = {
  SOL: "SOL-USD", ETH: "ETH-USD", BTC: "BTC-USD", USDC: "USDC-USD",
};

export const ALL_ASSETS = Object.keys(BINANCE_SYMBOL);

/* Parsers ---------------------------------------------------------- */

function toNum(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** Parse a Binance 24hrTicker frame (raw or combined-stream-wrapped). */
export function parseBinanceTicker(raw: unknown): { asset: string; usd: number; change24hPct: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // Combined stream wraps as { stream, data }.
  const frame = r.data && r.stream ? (r.data as Record<string, unknown>) : r;
  const sym = String(frame.s ?? "").toLowerCase();
  const usd = toNum(frame.c);
  if (!sym || !Number.isFinite(usd) || usd <= 0) return null;
  const asset = Object.keys(BINANCE_SYMBOL).find((a) => BINANCE_SYMBOL[a] === sym);
  if (!asset) return null;
  const change = toNum(frame.P);
  return { asset, usd, change24hPct: Number.isFinite(change) ? change : 0 };
}

/** Parse a Coinbase Exchange ticker-channel message. */
export function parseCoinbaseTicker(raw: unknown): { asset: string; usd: number; change24hPct: number } | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (r.type !== "ticker") return null;
  const product = String(r.product_id ?? "");
  const usd = toNum(r.price);
  if (!product || !Number.isFinite(usd) || usd <= 0) return null;
  const asset = Object.keys(COINBASE_PRODUCT).find((a) => COINBASE_PRODUCT[a] === product);
  if (!asset) return null;
  const open = toNum(r.open_24h);
  const change24hPct = Number.isFinite(open) && open > 0 ? ((usd - open) / open) * 100 : 0;
  return { asset, usd, change24hPct };
}

/* Freshness + arbitration ----------------------------------------- */

export const STALE_MS = 30_000;

export function isStale(ts: number, now: number, staleMs = STALE_MS): boolean {
  return now - ts > staleMs;
}

/**
 * Pick the best price for an asset from per-source candidates.
 * Priority: fresh binance > fresh coinbase > fresh coingecko >
 * stale binance > stale coinbase > stale coingecko. Returns null
 * only when no candidate exists at all.
 */
export function pickPrice(
  asset: string,
  cand: { binance?: StreamPrice; coinbase?: StreamPrice; coingecko?: StreamPrice },
  now: number,
): StreamPrice | null {
  const order: PriceSource[] = ["binance", "coinbase", "coingecko"];
  for (const src of order) {
    const p = cand[src];
    if (p && !isStale(p.ts, now)) return { ...p, source: src };
  }
  for (const src of order) {
    const p = cand[src];
    if (p) return { ...p, source: src };
  }
  return null;
}

/* Throttle --------------------------------------------------------- */

/**
 * Leading-edge throttle: calls `cb` for the first value in each
 * `intervalMs` window and drops subsequent values until the next
 * window. Trailing values are dropped (acceptable for price ticks,
 * which arrive again within a second).
 */
export function makeThrottler<T>(intervalMs: number, cb: (v: T) => void, now: () => number): (v: T) => void {
  let last = -Infinity;
  return (v: T) => {
    const t = now();
    if (t - last >= intervalMs) {
      last = t;
      cb(v);
    }
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test apps/web-next/src/lib/price-stream-core.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 6: Commit**

```bash
git add apps/web-next/src/lib/price-stream-core.ts apps/web-next/src/lib/price-stream-core.test.ts apps/web-next/tsconfig.json
git commit -m "feat(exchange): add pure price-stream core helpers + tests"
```

---

## Task 2: PriceStream manager + React hook (with fallback test)

**Files:**
- Create: `apps/web-next/src/lib/price-stream.ts`
- Create: `apps/web-next/src/lib/price-stream.test.ts`

**Interfaces:**
- Consumes (from Task 1): `ALL_ASSETS`, `BINANCE_SYMBOL`, `COINBASE_PRODUCT`, `parseBinanceTicker`, `parseCoinbaseTicker`, `pickPrice`, `isStale`, `makeThrottler`, `StreamPrice`, `PriceSource`.
- Produces: `StreamStatus`, `PriceStreamSnapshot`, `PriceStream` (class, constructor takes `{ socketFactory?, restFetcher? }`), `getPriceStream()`, `usePriceStream()` (React hook returning `PriceStreamSnapshot`).

- [ ] **Step 1: Write the failing fallback test**

Create `apps/web-next/src/lib/price-stream.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { PriceStream } from "./price-stream";

/** Minimal fake WebSocket for testing the manager without a network. */
interface FakeSocket {
  url: string;
  sent: string[];
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(d: string): void;
  close(): void;
  _open(): void;
  _msg(d: unknown): void;
}

function fakeSockets() {
  const sockets: FakeSocket[] = [];
  const factory = (url: string): FakeSocket => {
    const s: FakeSocket = {
      url, sent: [], readyState: 0,
      onopen: null, onmessage: null, onclose: null, onerror: null,
      send(d) { this.sent.push(d); },
      close() { this.readyState = 3; this.onclose?.({}); },
      _open() { this.readyState = 1; this.onopen?.({}); },
      _msg(d) { this.onmessage?.({ data: JSON.stringify(d) }); },
    };
    sockets.push(s);
    return s;
  };
  return { factory, sockets };
}

describe("PriceStream", () => {
  test("falls back to Coinbase when Binance closes before opening", () => {
    const { factory, sockets } = fakeSockets();
    const stream = new PriceStream({ socketFactory: factory, restFetcher: async () => ({ markets: [] }) });
    stream.start();

    // First socket opened is Binance.
    expect(sockets[0]?.url).toContain("binance");

    // Simulate a US-style geo-block: error then close before onopen.
    sockets[0].onerror?.({});
    sockets[0].close();

    // Coinbase should now have been opened.
    const cb = sockets.find((s) => s.url.includes("coinbase"));
    expect(cb).toBeTruthy();
    cb!._open();
    // Subscribe message must request the ticker channel for the majors.
    expect(JSON.stringify(cb!.sent)).toContain("ticker");
    expect(JSON.stringify(cb!.sent)).toContain("SOL-USD");

    // Deliver a Coinbase SOL tick -> snapshot reflects it from coinbase.
    cb!._msg({ type: "ticker", product_id: "SOL-USD", price: "150.5", open_24h: "149" });
    const snap = stream.getSnapshot();
    expect(snap.prices.SOL?.usd).toBe(150.5);
    expect(snap.prices.SOL?.source).toBe("coinbase");
    stream.stop();
  });

  test("parses a Binance tick into the snapshot", () => {
    const { factory, sockets } = fakeSockets();
    const stream = new PriceStream({ socketFactory: factory, restFetcher: async () => ({ markets: [] }) });
    stream.start();
    sockets[0]._open();
    sockets[0]._msg({ stream: "solusdt@ticker", data: { s: "SOLUSDT", c: "160", P: "3" } });
    const snap = stream.getSnapshot();
    expect(snap.prices.SOL?.usd).toBe(160);
    expect(snap.prices.SOL?.source).toBe("binance");
    stream.stop();
  });

  test("REST fallback populates prices for assets WS doesn't cover", async () => {
    const { factory } = fakeSockets();
    const stream = new PriceStream({
      socketFactory: factory,
      restFetcher: async () => ({ markets: [{ asset: "BONK", spotPriceUsd: 0.00002, spotChange24hPct: 5 }] }),
    });
    stream.start();
    // Allow the synchronous REST poll (called once on start) to resolve.
    await new Promise((r) => setTimeout(r, 10));
    const snap = stream.getSnapshot();
    expect(snap.prices.BONK?.usd).toBe(0.00002);
    expect(snap.prices.BONK?.source).toBe("coingecko");
    stream.stop();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/web-next/src/lib/price-stream.test.ts`
Expected: FAIL — cannot resolve `./price-stream`.

- [ ] **Step 3: Write the manager + hook**

Create `apps/web-next/src/lib/price-stream.ts`:

```ts
"use client";

/**
 * Live price stream for the Mute exchange.
 *
 * Browser-only singleton that resolves one live USD spot price per asset
 * from a priority chain: Binance (all assets, ~1s) → Coinbase (majors,
 * used when Binance is blocked/unhealthy) → CoinGecko REST (existing
 * /api/exchange/markets, polled every 30s, covers the long tail and acts
 * as the ultimate safety net).
 *
 * The pure parsing/arbitration logic is in price-stream-core.ts.
 */

import { useEffect, useState } from "react";
import {
  ALL_ASSETS, BINANCE_SYMBOL, COINBASE_PRODUCT, STALE_MS,
  isStale, makeThrottler, parseBinanceTicker, parseCoinbaseTicker, pickPrice,
  type PriceSource, type StreamPrice,
} from "./price-stream-core";

const BINANCE_WS = "wss://stream.binance.com:9443/stream";
const COINBASE_WS = "wss://ws-feed.exchange.coinbase.com";
const REST_POLL_MS = 30_000;
const HEALTH_GRACE_MS = 5_000; // if Binance hasn't opened by now, start Coinbase
const MAX_RECONNECT_MS = 30_000;
const EMIT_THROTTLE_MS = 250; // <= 4 React updates/sec

export type StreamStatus = "connecting" | "live" | "degraded" | "down";

export interface PriceStreamSnapshot {
  /** Best price per asset (keyed by "SOL", "ETH", …), or absent if unknown. */
  prices: Record<string, StreamPrice>;
  status: StreamStatus;
  /** Best source currently delivering fresh data, or null. */
  primary: PriceSource | null;
}

/** Minimal socket surface the manager depends on (Real WebSocket or a fake). */
export interface ManagedSocket {
  url: string;
  readyState: number;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
  send(data: string): void;
  close(): void;
}
export type SocketFactory = (url: string) => ManagedSocket;
type RestFetcher = () => Promise<{ markets: Array<{ asset: string; spotPriceUsd: number | null; spotChange24hPct: number | null }> }>;

type Listener = (snap: PriceStreamSnapshot) => void;

const SOURCE_PRIORITY: PriceSource[] = ["binance", "coinbase", "coingecko"];

export class PriceStream {
  private binancePrices: Record<string, StreamPrice> = {};
  private coinbasePrices: Record<string, StreamPrice> = {};
  private coingeckoPrices: Record<string, StreamPrice> = {};
  private listeners = new Set<Listener>();
  private binanceSocket: ManagedSocket | null = null;
  private coinbaseSocket: ManagedSocket | null = null;
  private coinbaseStarted = false;
  private reconnectDelayMs = 1_000;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private restTimer: ReturnType<typeof setInterval> | null = null;
  private readonly socketFactory: SocketFactory;
  private readonly restFetcher: RestFetcher;
  private started = false;

  constructor(opts?: { socketFactory?: SocketFactory; restFetcher?: RestFetcher }) {
    this.socketFactory = opts?.socketFactory ?? ((url) => new WebSocket(url) as unknown as ManagedSocket);
    this.restFetcher = opts?.restFetcher ?? defaultRestFetcher;
  }

  /* lifecycle ----------------------------------------------------- */

  start(): void {
    if (this.started) return;
    this.started = true;
    this.openBinance();
    void this.pollRest();
    this.restTimer = setInterval(() => void this.pollRest(), REST_POLL_MS);
    // Recompute/republish periodically so staleness transitions surface.
    this.staleTimer = setInterval(() => this.emit(), 2_000);
  }

  stop(): void {
    this.started = false;
    this.binanceSocket?.close();
    this.coinbaseSocket?.close();
    this.binanceSocket = null;
    this.coinbaseSocket = null;
    if (this.restTimer) clearInterval(this.restTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.restTimer = null;
    this.staleTimer = null;
  }

  /** Subscribe to snapshot updates. Calls back immediately with the current snapshot. */
  subscribe(cb: Listener): () => void {
    this.listeners.add(cb);
    cb(this.snapshot());
    return () => { this.listeners.delete(cb); };
  }

  getSnapshot(): PriceStreamSnapshot {
    return this.snapshot();
  }

  /* Binance ------------------------------------------------------- */

  private openBinance(): void {
    if (!this.started) return;
    const streams = ALL_ASSETS.map((a) => `${BINANCE_SYMBOL[a]}@ticker`).join("/");
    const ws = this.socketFactory(`${BINANCE_WS}?streams=${streams}`);
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.reconnectDelayMs = 1_000; // reset backoff on success
    };
    ws.onmessage = (e) => {
      const parsed = parseBinanceTicker(typeof e.data === "string" ? JSON.parse(e.data) : e.data);
      if (parsed) {
        this.binancePrices[parsed.asset] = { usd: parsed.usd, change24hPct: parsed.change24hPct, source: "binance", ts: Date.now() };
        this.emit();
      }
    };
    ws.onclose = () => {
      this.binanceSocket = null;
      this.maybeStartCoinbase();
      if (this.started) {
        const delay = Math.min(this.reconnectDelayMs, MAX_RECONNECT_MS);
        this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_MS);
        setTimeout(() => this.openBinance(), delay);
      }
    };
    ws.onerror = () => { /* close handler performs fallback + reconnect */ };
    this.binanceSocket = ws;
    // If Binance hasn't successfully opened within the grace window, fall back.
    setTimeout(() => {
      if (!opened && this.started) this.maybeStartCoinbase();
    }, HEALTH_GRACE_MS);
  }

  /* Coinbase (fallback) ------------------------------------------- */

  private maybeStartCoinbase(): void {
    if (this.coinbaseStarted) return;
    this.coinbaseStarted = true;
    const products = Object.values(COINBASE_PRODUCT);
    const ws = this.socketFactory(COINBASE_WS);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "subscribe", channels: [{ name: "ticker", product_ids: products }] }));
    };
    ws.onmessage = (e) => {
      const parsed = parseCoinbaseTicker(typeof e.data === "string" ? JSON.parse(e.data) : e.data);
      if (parsed) {
        this.coinbasePrices[parsed.asset] = { usd: parsed.usd, change24hPct: parsed.change24hPct, source: "coinbase", ts: Date.now() };
        this.emit();
      }
    };
    ws.onclose = () => { this.coinbaseSocket = null; };
    ws.onerror = () => { /* keep; close handler resets */ };
    this.coinbaseSocket = ws;
  }

  /* CoinGecko REST fallback --------------------------------------- */

  private async pollRest(): Promise<void> {
    try {
      const data = await this.restFetcher();
      const now = Date.now();
      for (const m of data.markets ?? []) {
        if (m && m.spotPriceUsd != null) {
          this.coingeckoPrices[m.asset] = { usd: m.spotPriceUsd, change24hPct: m.spotChange24hPct ?? 0, source: "coingecko", ts: now };
        }
      }
      this.emit();
    } catch {
      /* network failure — keep last-known values */
    }
  }

  /* snapshot + notify --------------------------------------------- */

  private snapshot(): PriceStreamSnapshot {
    const now = Date.now();
    const prices: Record<string, StreamPrice> = {};
    let wsFresh = false;
    let restFresh = false;
    let primary: PriceSource | null = null;
    for (const asset of ALL_ASSETS) {
      const p = pickPrice(asset, {
        binance: this.binancePrices[asset],
        coinbase: this.coinbasePrices[asset],
        coingecko: this.coingeckoPrices[asset],
      }, now);
      if (!p) continue;
      prices[asset] = p;
      if (!isStale(p.ts, now)) {
        if (p.source === "coingecko") restFresh = true; else wsFresh = true;
        if (!primary || SOURCE_PRIORITY.indexOf(p.source) < SOURCE_PRIORITY.indexOf(primary)) {
          primary = p.source;
        }
      }
    }
    let status: StreamStatus;
    if (wsFresh) status = "live";
    else if (restFresh) status = "degraded";
    else if (this.started) status = "connecting";
    else status = "down";
    return { prices, status, primary };
  }

  private readonly notify = makeThrottler<PriceStreamSnapshot>(EMIT_THROTTLE_MS, (snap) => {
    for (const l of this.listeners) l(snap);
  }, Date.now);

  private emit(): void {
    this.notify(this.snapshot());
  }
}

async function defaultRestFetcher(): ReturnType<RestFetcher> {
  const r = await fetch("/api/exchange/markets");
  return (await r.json()) as { markets: Array<{ asset: string; spotPriceUsd: number | null; spotChange24hPct: number | null }> };
}

/* Singleton + React hook ------------------------------------------ */

let _stream: PriceStream | null = null;
export function getPriceStream(): PriceStream {
  if (!_stream) _stream = new PriceStream();
  return _stream;
}

/**
 * Subscribe a React component to the live price stream.
 * Returns the latest snapshot; updates are throttled to ~4/sec.
 */
export function usePriceStream(): PriceStreamSnapshot {
  const [snap, setSnap] = useState<PriceStreamSnapshot>(() => getPriceStream().getSnapshot());
  useEffect(() => {
    const s = getPriceStream();
    s.start();
    return s.subscribe(setSnap);
  }, []);
  return snap;
}

export { STALE_MS };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test apps/web-next/src/lib/price-stream.test.ts apps/web-next/src/lib/price-stream-core.test.ts`
Expected: PASS — all tests in both files green.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/lib/price-stream.ts apps/web-next/src/lib/price-stream.test.ts
git commit -m "feat(exchange): add multi-source PriceStream manager + usePriceStream hook"
```

---

## Task 3: Wire the live stream into the exchange UI

**Files:**
- Modify: `apps/web-next/src/app/exchange/page.tsx`

**Interfaces:**
- Consumes (from Task 2): `usePriceStream()` → `PriceStreamSnapshot` with `prices: Record<asset, StreamPrice>` and `status`, `primary`.
- Produces: live-updating market cards, header price, chart right-edge candle, and a connection-status chip.

- [ ] **Step 1: Add the import and consume the hook**

In `apps/web-next/src/app/exchange/page.tsx`, add to the existing imports near the top (after the `import type { PrivacyPolicyLabel }` line, around line 10):

```ts
import { usePriceStream } from "@/lib/price-stream";
```

Inside the `ExchangePage` component, immediately after the line `const [tf, setTf] = useState("1H");` (around line 167), add the stream + derived live data:

```ts
  const stream = usePriceStream();

  // Merge live spot prices (per underlying asset) into the market rows.
  const liveMarkets = useMemo(() => markets.map((m) => {
    const sp = stream.prices[m.asset];
    return sp
      ? { ...m, spotPriceUsd: sp.usd, spotChange24hPct: sp.change24hPct, spotFetchedAt: sp.ts }
      : m;
  }), [markets, stream]);

  const currentMarket = liveMarkets.find((m) => m.symbol === activeMarket);
  const activeSpot = currentMarket ? stream.prices[currentMarket.asset] : undefined;
```

Then **delete** the existing standalone declaration `const currentMarket = markets.find(m => m.symbol === activeMarket);` (around line 180) — it is now superseded by the version above. (Keep the line `const noteSizeUsd = currentMarket?.baseNoteSizeUsd ?? 1000;` that depends on it.)

- [ ] **Step 2: Make the chart's right-edge candle track the live price**

Replace the `<CandleChart candles={candles} />` usage (around line 382) with a live-edge version. Just above the `return (` of the component (after the `spread` useMemo, around line 286), add:

```ts
  const liveCandles = useMemo<Candle[]>(() => {
    if (!candles.length) return candles;
    const usd = activeSpot?.usd;
    if (usd == null) return candles;
    const next = candles.slice();
    const last = { ...next[next.length - 1] };
    last.close = usd;
    last.high = Math.max(last.high, usd);
    last.low = Math.min(last.low, usd);
    next[next.length - 1] = last;
    return next;
  }, [candles, activeSpot]);
```

Then change the chart call to use `liveCandles`:

```tsx
              <CandleChart candles={liveCandles} />
```

- [ ] **Step 3: Render the markets from `liveMarkets` and add a status chip**

In the market selector (the `markets.map(m => ...)` block, around line 313), change `markets.map` → `liveMarkets.map`. The block already reads `m.spotPriceUsd` / `m.spotChange24hPct`, so no other change is needed there.

Add a connection-status chip next to the existing "DEVNET LIVE" chip in the header. Find the header chip (around line 302) and add a new chip after it:

```tsx
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] mono text-green bg-green-soft px-2 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green animate-glow" /> DEVNET LIVE
            </span>
            <PriceStatusChip status={stream.status} primary={stream.primary} />
```

Add the `PriceStatusChip` sub-component at the bottom of the file next to the other sub-components (after `RowKV`):

```tsx
function PriceStatusChip({ status, primary }: { status: string; primary: string | null }) {
  const tone =
    status === "live" ? { dot: "bg-green", text: "text-green", soft: "bg-green-soft" }
    : status === "degraded" ? { dot: "bg-amber-400", text: "text-amber-500", soft: "bg-amber-50" }
    : { dot: "bg-muted", text: "text-muted", soft: "bg-bg" };
  const label = status === "live" ? `LIVE · ${primary ?? "WS"}`
    : status === "degraded" ? "FALLBACK · COINGECKO"
    : status === "connecting" ? "CONNECTING…"
    : "OFFLINE";
  return (
    <span className={`hidden sm:inline-flex items-center gap-1.5 text-[10px] mono ${tone.text} ${tone.soft} px-2 py-1 rounded-full`}>
      <span className={`w-1.5 h-1.5 rounded-full ${tone.dot} ${status === "live" || status === "degraded" ? "animate-glow" : ""}`} />
      {label}
    </span>
  );
}
```

- [ ] **Step 4: Slow down the own-data poll (prices now come from the stream)**

The prices no longer need 6s polling. Change the order-book/listings/trades poll interval. Replace (around line 208):

```ts
  useEffect(() => { const id = setInterval(refresh, 6000); return () => clearInterval(id); }, [refresh]);
```

with:

```ts
  useEffect(() => { const id = setInterval(refresh, 12000); return () => clearInterval(id); }, [refresh]);
```

- [ ] **Step 5: Verify it runs and type-checks**

Run: `cd apps/web-next && bun run lint` — expected: no errors referencing the new code.
Run: `cd apps/web-next && bun run build` — expected: build succeeds (test files are excluded from type-check by Task 1's tsconfig change).

- [ ] **Step 6: Manual check**

Run: `cd apps/web-next && bun run dev`, open `http://localhost:3000/exchange`. Expected:
- Market card prices and the header big price update within ~1s (not every 6s).
- The chart's right edge (last candle close + the dashed price line) moves with the live price.
- The status chip reads `LIVE · binance` (or `LIVE · coinbase` / `FALLBACK · COINGECKO` depending on region).

- [ ] **Step 7: Commit**

```bash
git add apps/web-next/src/app/exchange/page.tsx
git commit -m "feat(exchange): stream live prices into UI + status chip + live chart edge"
```

---

## Task 4: Optimistic + reliable buy/sell

**Files:**
- Modify: `apps/web-next/src/app/exchange/page.tsx`

**Interfaces:**
- Consumes: existing `handleBuy` / `handleSell` handlers, `setListings`, `setTrades`, `addLog`.
- Produces: instant local state updates on buy/sell; clear "acquired N notes" confirmation; clear 409 ("just filled") message.

- [ ] **Step 1: Optimistic sell — show the new ask instantly**

In `handleSell` (around line 219), immediately after the successful `const data = await res.json();` and **before** the existing `addLog(`✓ Listed ...`)` line, optimistically prepend the new listing to local state. Insert:

```ts
      // Optimistic: surface the new ask immediately, before refresh reconciles.
      setListings((prev) => [{
        id: data.listing.id,
        seller: wallet.publicKey!.toBase58(),
        noteCount, noteSizeUsd,
        faceValueUsd: noteCount * noteSizeUsd,
        askPriceUsd: sellAskPrice,
        discountBps: sellDiscountBps,
        yieldBps: sellYield,
        daysToMaturity: currentMarket?.maturityDays ?? 30,
        privacy,
        creditLineId: data.listing.creditLineId,
        market: activeMarket,
        createdAt: Date.now(),
        status: "active",
      } as NoteListing, ...prev]);
```

- [ ] **Step 2: Optimistic buy + "acquired N notes" confirmation + 409 message**

In `handleBuy` (around line 251):

(a) Replace the error branch:

```ts
      const data = await res.json();
      if (!res.ok) { addLog(`Buy failed: ${data.error}`); setBusy(false); return; }
```

with a clearer conflict handler:

```ts
      const data = await res.json();
      if (!res.ok) {
        if (res.status === 409) addLog(`That ask was just filled by someone else — refreshing…`);
        else addLog(`Buy failed: ${data.error}`);
        setBusy(false);
        await refresh();
        return;
      }
```

(b) Immediately after the success log line `addLog(`✓ Filled ${data.trade.id} — shielded ${data.trade.settlementId}`);` add an explicit acquisition confirmation:

```ts
      addLog(`✓ You acquired ${target.noteCount} ${activeMarket} notes (commitment ${data.trade.settlementId.slice(0, 12)}…)`);
```

(c) Optimistically remove the filled listing and prepend the trade locally, before the on-chain settle. Insert right after the acquisition log line above:

```ts
      // Optimistic: clear the filled ask and show the trade immediately.
      setListings((prev) => prev.filter((l) => l.id !== target.id));
      setTrades((prev) => [{
        id: data.trade.id, listingId: target.id,
        buyer: wallet.publicKey!.toBase58(), seller: target.seller,
        noteCount: target.noteCount, faceValueUsd: target.faceValueUsd,
        priceUsd: target.askPriceUsd, discountBps: target.discountBps,
        settlementId: env.envelope.settlementId, timestamp: Date.now(),
      } as Trade, ...prev]);
```

- [ ] **Step 3: Verify it type-checks**

Run: `cd apps/web-next && bun run lint` — expected: no new errors.
Run: `cd apps/web-next && bun run build` — expected: succeeds.

- [ ] **Step 4: Manual check**

Run: `cd apps/web-next && bun run dev`, connect a devnet wallet, open `/exchange`.
- Sell: the new ask appears in the Active Asks table instantly (before the 12s poll).
- Buy: the filled ask disappears instantly, the trade appears in Market Trades instantly, and the activity log shows `✓ You acquired N <MARKET> notes …`.
- Trigger a 409 path manually (open two tabs, buy the same ask): the second shows `That ask was just filled by someone else — refreshing…`.

- [ ] **Step 5: Commit**

```bash
git add apps/web-next/src/app/exchange/page.tsx
git commit -m "feat(exchange): optimistic buy/sell + acquired-notes confirmation + 409 handling"
```

---

## Task 5: End-to-end verification + regression

**Files:** none (verification only, plus any fixups discovered).

- [ ] **Step 1: Unit + integration tests pass**

Run: `bun test apps/web-next/src/lib/`
Expected: all `price-stream-core.test.ts` and `price-stream.test.ts` tests pass.

- [ ] **Step 2: Existing exchange regression still passes**

Run: `bun run exchange:test`
Expected: the existing exchange end-to-end test passes unchanged (no behavioral change to matching/settlement).

- [ ] **Step 3: Production build is green**

Run: `cd apps/web-next && bun run build`
Expected: build completes with no type errors (test files excluded).

- [ ] **Step 4: Live fallback verification in the browser**

Run: `cd apps/web-next && bun run dev`, open `/exchange`, then in the browser DevTools:
- Confirm prices tick < 1s and the chip reads `LIVE · binance`.
- Block Binance: DevTools → Application/Network → block `stream.binance.com` (or use the "Network request blocking" tab), then reload. Expected: within ~5s the chip flips to `LIVE · coinbase` (majors) and alt markets fall to `FALLBACK · COINGECKO`; all prices still move.
- Kill all WS (go offline briefly): chip → `OFFLINE`; values hold then go stale; reconnect restores `LIVE`.

- [ ] **Step 5: Commit any fixups (if needed)**

If verification surfaced a fix, commit it:

```bash
git add -A
git commit -m "fix(exchange): <what verification surfaced>"
```

If nothing changed, this step is a no-op.

---

## Self-Review (run after writing — results)

- **Spec coverage:**
  - Continuous sub-second prices → Task 1 (core) + Task 2 (manager) + Task 3 (UI). ✓
  - Multi-source fallback Binance→Coinbase→CoinGecko → Task 2 (`openBinance`, `maybeStartCoinbase`, `pollRest`) + Task 2 test. ✓
  - No server / no key / Vercel-compatible → Global Constraints + client-only design. ✓
  - Staleness watchdog / never fake → Task 1 `isStale` + Task 2 status derivation + Task 3 chip. ✓
  - Live chart right edge → Task 3 Step 2 (`liveCandles`). ✓
  - Optimistic buy/sell → Task 4. ✓
  - 409 conflict handling → Task 4 Step 2(a). ✓
  - "Acquired N notes" confirmation → Task 4 Step 2(b). ✓
  - Connection-status chip → Task 3 Step 3. ✓
  - Tests for arbiter/parsers/throttle/fallback → Task 1 + Task 2. ✓
- **Placeholder scan:** none. Every code step contains complete code.
- **Type consistency:** `StreamPrice`, `PriceSource`, `PriceStreamSnapshot`, `ManagedSocket`, `SocketFactory`, `RestFetcher` defined in Task 2 and consumed consistently in Task 3. `parseBinanceTicker`/`parseCoinbaseTicker`/`pickPrice`/`isStale`/`makeThrottler` signatures in Task 1 match Task 2 usage. `Market`, `NoteListing`, `Trade` (existing in `page.tsx`) reused in Task 4.

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

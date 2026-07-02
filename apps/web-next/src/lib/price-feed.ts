/**
 * Real market price feed — fetches LIVE spot prices and OHLC candles from
 * public APIs (CoinGecko, no API key required). Server-side only (called from
 * Next.js route handlers), with aggressive caching so we stay well under free
 * rate limits.
 *
 * The exchange trades credit notes denominated in real assets (SOL, ETH, BTC,
 * USDC). This module anchors those markets to real, live prices instead of
 * synthetic values.
 */

/* ------------------------------------------------------------------ */
/*  Asset → CoinGecko coin-id map                                      */
/* ------------------------------------------------------------------ */

export const ASSET_COIN_ID: Record<string, string> = {
  SOL: "solana",
  ETH: "ethereum",
  BTC: "bitcoin",
  USDC: "usd-coin",
  JUP: "jupiter-exchange-solana",
  BONK: "bonk",
  WIF: "dogwifcoin",
  RAY: "raydium",
  ORCA: "orca",
  PYTH: "pyth-network",
  HNT: "helium",
  JTO: "jito-governance-token",
};

export const ASSET_DECIMALS: Record<string, number> = {
  SOL: 9, ETH: 8, BTC: 8, USDC: 6, JUP: 6, BONK: 5, WIF: 6,
  RAY: 6, ORCA: 6, PYTH: 6, HNT: 6, JTO: 9,
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface SpotPrice {
  asset: string;
  usd: number;
  change24hPct: number; // e.g. +2.34
  marketCapUsd: number | null;
  fetchedAt: number;
}

export interface OhlcCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/* ------------------------------------------------------------------ */
/*  Cache                                                              */
/* ------------------------------------------------------------------ */

const SPOT_TTL = 60_000; // 60s
const OHLC_TTL = 300_000; // 5 min
let spotCache: { at: number; prices: Record<string, SpotPrice> } | null = null;
const ohlcCache: Record<string, { at: number; candles: OhlcCandle[] }> = {};

/* ------------------------------------------------------------------ */
/*  Fetch helpers                                                      */
/* ------------------------------------------------------------------ */

async function fetchJson(url: string, timeoutMs = 8000): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

/**
 * Get live spot prices for SOL, ETH, BTC, USDC.
 * Cached for 60s. Falls back to last-known values on failure.
 */
export async function getSpotPrices(): Promise<Record<string, SpotPrice>> {
  if (spotCache && Date.now() - spotCache.at < SPOT_TTL) return spotCache.prices;
  try {
    const coinIds = Object.values(ASSET_COIN_ID).join(",");
    // simple/price returns { coinId: { usd, usd_24h_change, usd_market_cap } }
    const data = await fetchJson(
      `https://api.coingecko.com/api/v3/simple/price?ids=${coinIds}&vs_currencies=usd&include_24hr_change=true&include_market_cap=true`,
    );
    const prices: Record<string, SpotPrice> = {};
    for (const [asset, coinId] of Object.entries(ASSET_COIN_ID)) {
      const d = data[coinId];
      if (d?.usd) {
        prices[asset] = {
          asset,
          usd: d.usd,
          change24hPct: typeof d.usd_24h_change === "number" ? d.usd_24h_change : 0,
          marketCapUsd: d.usd_market_cap ?? null,
          fetchedAt: Date.now(),
        };
      }
    }
    if (Object.keys(prices).length) spotCache = { at: Date.now(), prices };
    return spotCache?.prices ?? {};
  } catch {
    // network/rate-limit failure — return last cache (may be empty)
    return spotCache?.prices ?? {};
  }
}

/**
 * Get real OHLC candles for an asset. Cached 5 min.
 * Returns hourly candles over `days` (CoinGecko granularity auto-scales).
 */
export async function getOhlc(asset: string, days = 7): Promise<OhlcCandle[]> {
  const coinId = ASSET_COIN_ID[asset];
  if (!coinId) return [];
  const cached = ohlcCache[asset];
  if (cached && Date.now() - cached.at < OHLC_TTL) return cached.candles;
  try {
    const raw: number[][] = await fetchJson(
      `https://api.coingecko.com/api/v3/coins/${coinId}/ohlc?vs_currency=usd&days=${days}`,
    );
    // CoinGecko OHLC: [timestamp, open, high, low, close]
    const candles: OhlcCandle[] = raw.map((c) => ({
      time: c[0], open: c[1], high: c[2], low: c[3], close: c[4],
    }));
    if (candles.length) ohlcCache[asset] = { at: Date.now(), candles };
    return candles;
  } catch {
    return cached?.candles ?? [];
  }
}

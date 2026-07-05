# Live price WebSocket + instant buy/sell — Design

**Date:** 2026-07-05
**Status:** Proposed (awaiting approval)
**Scope:** `apps/web-next` (exchange page + new client lib). No on-chain program changes.

## Problem

The exchange already uses real CoinGecko prices, but the data is **not continuous**:

- The browser polls REST every **6s** (`apps/web-next/src/app/exchange/page.tsx:208`).
- The server caches spot prices for **60s** (`apps/web-next/src/lib/price-feed.ts:60`).

Effective tick resolution is ~6–60s, so prices feel choppy and the chart/order book only
jumps on each poll. Buy and sell work, but the UI waits for the next poll to reflect a trade.

Deploy target is Vercel (`.vercel/` present, `NEXT_PUBLIC_API_URL` empty so the Next.js app
serves its own `/api/exchange/*` route handlers). **A persistent WebSocket server cannot run on
Vercel serverless**, so the correct pattern is for the **browser to open a WS directly to a
public price feed** — no new infra, no API key, sub-second ticks.

## Goal

1. Prices stream **continuously** (sub-second) into the exchange UI for every market.
2. Buy **and** sell execute reliably and feel **instant** (optimistic UI).
3. Works for **every user regardless of region** (US-safe), with no API key and no server.
4. Graceful degradation: if a source dies, the UI keeps showing live-ish prices, never fakes it.

## Decision: multi-source client stream manager

Priority chain, resolved **per asset**:

1. **Binance** combined ticker stream — `wss://stream.binance.com:9443/stream?streams=<sym>@ticker/…`
   - Covers all 12 assets (SOL, ETH, BTC, USDC, JUP, BONK, WIF, RAY, ORCA, PYTH, HNT, JTO).
   - ~1s updates, no auth, IP-based geo-restriction (US IPs may be blocked).
2. **Coinbase** Advanced Trade WS — opened only if Binance fails its opening health check.
   - US-safe. Covers majors: SOL-USD, ETH-USD, BTC-USD, USDC-USD.
3. **CoinGecko REST** (existing `getSpotPrices`) polled every 30s.
   - Covers the long tail (assets Coinbase lacks) and is the ultimate safety net.

Pyth Hermes was considered (Solana-native, on-brand) but its **WebSocket API is a paid Pro
feature**; the free tier is REST/SSE only. Set aside in favour of a keyless solution.

## Architecture

```
Binance WS  ─┐
Coinbase WS  ─┼─→ price-stream manager (per-asset resolve) ─→ usePriceStream() ─→ UI
CoinGecko    ─┘     · health + reconnect (backoff)                            (cards, header,
                   · staleness watchdog (30s)                                  chart edge, mid,
                   · throttle ~4/s to React                                    status chip)

User clicks Buy/Sell ─→ optimistic local update ─→ REST POST /api/exchange/*
                       ─→ exchange-store match ─→ on-chain devnet Memo settle
                       ─→ confirm (✓ acquired N notes) / refresh
```

### Components

**`src/lib/price-stream.ts`** (new, browser-only singleton)
- `startPriceStream()` — idempotent; opens sources, starts watchdogs.
- `subscribe(cb)` / `getSnapshot()` — for non-React consumers.
- `usePriceStream()` — React hook returning `{ prices: Record<asset, {usd, change24hPct, source, ts}>, source, status }`.
- Internal:
  - `BinanceAdapter` — parses `<sym>@ticker` → `{asset, usd, change24hPct}`.
  - `CoinbaseAdapter` — parses `ticker` channel → same shape.
  - `RestFallback` — wraps existing `getSpotPrices` via `/api/exchange/markets`.
  - Source arbiter — picks the freshest non-stale value per asset; records `source`.

**`src/app/exchange/page.tsx`** (modified)
- Replace the price-driven parts of the 6s poll with `usePriceStream()`.
- Keep a slower (~12s) poll for *own* data only (order book, listings, trades).
- Chart: keep CoinGecko OHLC; append a synthetic live candle whose close = streaming price.
- Buy/sell: optimistic update + clearer confirmations (see below).

**`src/lib/exchange-store.ts`** (no behavior change) — already correct; the `409` path is
already returned by `fillListing` ("Listing no longer active"). UI just needs to surface it.

**`src/app/api/exchange/markets/route.ts`** (unchanged) — still merges CoinGecko spot for the
initial server render; the client stream then takes over and refreshes it live.

## Data model

```ts
interface StreamPrice {
  usd: number;
  change24hPct: number;     // 24h % change
  source: "binance" | "coinbase" | "coingecko";
  ts: number;               // ms of last tick
}
type StreamStatus = "connecting" | "live" | "degraded" | "down";
interface PriceStreamSnapshot {
  prices: Record<string, StreamPrice>; // keyed by asset: SOL, ETH, ...
  status: StreamStatus;
  primary: "binance" | "coinbase" | "coingecko";
}
```

Asset→source-symbol maps live in `price-stream.ts` (mirrors `ASSET_COIN_ID` in `price-feed.ts`).

## Error handling & resilience

- **WS close/error:** exponential backoff reconnect (1s, 2s, 4s, 8s, cap 30s); reset on first tick.
- **Health check:** if Binance socket closes (or errors) within ~5s of opening, mark it unhealthy
  and open Coinbase. Retry Binance in the background every 60s (region can change on VPN, etc.).
- **Staleness:** per-asset watchdog — no tick in 30s → clear that asset's WS value, rely on REST.
- **Never fake it:** a stale/down asset shows `—` or the last REST value with a "stale" chip,
  never a silently-stuck "live" number.
- **Throttle:** coalesce ticks into ≤4 React updates/s.

## Instant buy & sell

- **Optimistic UI:** on submit, immediately mutate local `listings`/`trades` state (mark filled /
  prepend ask) so the table reacts before the network round-trip.
- **Status feedback:** button → "Processing…" → on success `✓ Filled <id>` + on buy an explicit
  `✓ You acquired <N> <MARKET> notes (commitment <hash>)` line in the activity log.
- **Conflict handling:** `409` from `/api/exchange/buy` → log "Already filled / unavailable,
  refreshing…" and refresh listings.
- **On-chain settle:** unchanged — Memo commitment on devnet; link to explorer.

## Testing

- **Unit (`bun test`):** the source arbiter, staleness watchdog, and throttle logic are
  tested with a mocked `WebSocket` (inject a fake `globalThis.WebSocket`). Covers:
  - Binance tick updates the price; Coinbase fallback engages when Binance errors on open.
  - Stale asset falls back to REST; down state surfaces `status: "down"`.
- **Manual:** `bun run dev:next`, open `/exchange`:
  1. Prices tick < 1s; chart right edge moves.
  2. Block `stream.binance.com` in devtools → status flips to Coinbase/REST, prices still move.
  3. Buy → table updates instantly, "acquired N notes" appears, devnet tx link logs.
  4. Sell → new ask appears instantly at the right level.
- **Regression:** `bun run exchange:test` still passes.

## Non-goals (YAGNI)

- No custom WebSocket server (Vercel can't host it; not needed).
- No replacement of CoinGecko OHLC for historical candles.
- No change to on-chain settlement, note-vault, or confidentiality logic.
- No user accounts / persistence / DB.
- No order matching changes (off-chain match + on-chain settle stays as-is).

## Open questions

None blocking. (Provider choice was confirmed: multi-source fallback.)

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
const HEALTH_GRACE_MS = 5_000; // if Binance hasn't opened by then, start Coinbase
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

/** Minimal socket surface the manager depends on (real WebSocket or a fake). */
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

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
    const now = 100_000;
    const fresh = 99_500; // 500ms ago — fresh
    const stale = now - 31_000; // 31s ago — past the 30s threshold
    const binance: StreamPrice = { usd: 150, change24hPct: 1, source: "binance", ts: fresh };
    const coinbase: StreamPrice = { usd: 151, change24hPct: 1, source: "coinbase", ts: fresh };
    expect(pickPrice("SOL", { binance, coinbase }, now)?.source).toBe("binance");
    expect(pickPrice("SOL", { coinbase }, now)?.source).toBe("coinbase");

    // Binance stale -> fall through to fresh coinbase
    const staleBinance: StreamPrice = { ...binance, ts: stale };
    expect(pickPrice("SOL", { binance: staleBinance, coinbase }, now)?.source).toBe("coinbase");

    // All fresh sources absent, only stale value -> returns it (best effort)
    expect(pickPrice("SOL", { binance: staleBinance }, now)?.source).toBe("binance");

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

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

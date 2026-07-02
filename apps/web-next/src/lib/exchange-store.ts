/**
 * In-memory order book for the Mute credit-note exchange.
 *
 * A peer-to-peer marketplace where market makers who have drawn confidential
 * credit notes can list them for sale, and buyers (other market makers,
 * treasuries, funds) can purchase them — typically at a discount to face value.
 *
 * The order book itself is off-chain (standard exchange architecture: off-chain
 * matching, on-chain settlement). Each filled trade references a shielded
 * settlement envelope from lib/stealth-settlement.
 *
 * State is module-scoped — it persists across requests within a single server
 * instance (dev server / single-region Vercel function). This is intentional
 * for a demo-grade exchange; production would back this with a database.
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type PrivacyPolicyLabel =
  | "Public"
  | "Umbra"
  | "Arcium"
  | "Umbra+Arcium"
  | "MagicBlock";

/** A market = asset + tenor (maturity) pair, e.g. USDC-30D. */
export interface Market {
  symbol: string;
  asset: string;
  maturityDays: number;
  baseNoteSizeUsd: number;
  /** Last traded price as a fraction of face (1.0 = par). */
  lastPrice: number;
  /** 24h change in basis points (price). */
  change24hBps: number;
  /** 24h volume in USD. */
  volume24hUsd: number;
  /** 24h high / low as fractions of face. */
  high24h: number;
  low24h: number;
}

/** One OHLC candle of price (fraction of face) for the chart. */
export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volumeUsd: number;
}

export interface NoteListing {
  id: string;
  /** Seller's wallet address. */
  seller: string;
  /** Number of notes in the lot. */
  noteCount: number;
  /** Per-note face value in USD (encrypted on-chain; shown here for the listing). */
  noteSizeUsd: number;
  /** Total face value = noteCount * noteSizeUsd. */
  faceValueUsd: number;
  /** Asking price in USD for the whole lot. */
  askPriceUsd: number;
  /** Discount to face value in basis points (positive = below par). */
  discountBps: number;
  /** Annualized yield to buyer at the asking price (bps). */
  yieldBps: number;
  /** Days to maturity (drives the annualized yield). */
  daysToMaturity: number;
  /** Privacy rail protecting the underlying notes. */
  privacy: PrivacyPolicyLabel;
  /** Source credit line (truncated address for display). */
  creditLineId: string;
  /** Market symbol this listing belongs to. */
  market: string;
  createdAt: number;
  status: "active" | "filled" | "cancelled";
}

/** A synthetic bid (buyer wanting notes at a discount). */
export interface Bid {
  priceBps: number; // price as fraction of face, in bps (9500 = 0.95)
  noteCount: number;
}

export interface Trade {
  id: string;
  listingId: string;
  buyer: string;
  seller: string;
  noteCount: number;
  faceValueUsd: number;
  priceUsd: number;
  discountBps: number;
  /** Shielded settlement envelope id (from lib/stealth-settlement). */
  settlementId: string;
  timestamp: number;
}

/* ------------------------------------------------------------------ */
/*  Store                                                              */
/* ------------------------------------------------------------------ */

const listings: NoteListing[] = [];
const trades: Trade[] = [];
const markets: Market[] = [];
const candlesByMarket: Record<string, Candle[]> = {};
const bidsByMarket: Record<string, Bid[]> = {};
let seeded = false;

/** Deterministic pseudo-random generator (seeded) so price history is stable across requests. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Generate OHLC candle history for a market via a bounded random walk around baseline. */
function seedCandles(baselinePrice: number, count: number, rng: () => number): Candle[] {
  const candles: Candle[] = [];
  const now = Date.now();
  let prev = baselinePrice;
  for (let i = count - 1; i >= 0; i--) {
    const drift = (rng() - 0.5) * 0.012; // ±0.6% per candle
    const open = prev;
    const close = Math.max(0.85, Math.min(1.0, open + drift));
    const high = Math.max(open, close) + rng() * 0.004;
    const low = Math.min(open, close) - rng() * 0.004;
    candles.push({
      time: now - i * 3600_000, // hourly candles
      open, high, low, close,
      volumeUsd: Math.round(5000 + rng() * 45000),
    });
    prev = close;
  }
  return candles;
}

/** Seed markets, price history, listings, and a synthetic bid book on first access. */
function ensureSeeded(): void {
  if (seeded) return;
  seeded = true;
  const now = Date.now();

  // Markets: asset + tenor pairs with distinct baseline discounts.
  const marketDefs: Array<{ symbol: string; asset: string; maturityDays: number; baseNoteSizeUsd: number; baseline: number; seed: number }> = [
    { symbol: "USDC-7D",  asset: "USDC", maturityDays: 7,  baseNoteSizeUsd: 1000, baseline: 0.985, seed: 101 },
    { symbol: "USDC-30D", asset: "USDC", maturityDays: 30, baseNoteSizeUsd: 1000, baseline: 0.965, seed: 102 },
    { symbol: "USDC-90D", asset: "USDC", maturityDays: 90, baseNoteSizeUsd: 5000, baseline: 0.955, seed: 103 },
    { symbol: "SOL-7D",   asset: "SOL",  maturityDays: 7,  baseNoteSizeUsd: 1000, baseline: 0.980, seed: 201 },
    { symbol: "SOL-14D",  asset: "SOL",  maturityDays: 14, baseNoteSizeUsd: 2500, baseline: 0.975, seed: 202 },
    { symbol: "ETH-14D",  asset: "ETH",  maturityDays: 14, baseNoteSizeUsd: 1000, baseline: 0.978, seed: 301 },
    { symbol: "ETH-45D",  asset: "ETH",  maturityDays: 45, baseNoteSizeUsd: 2000, baseline: 0.970, seed: 302 },
    { symbol: "BTC-30D",  asset: "BTC",  maturityDays: 30, baseNoteSizeUsd: 5000, baseline: 0.982, seed: 401 },
    { symbol: "BTC-60D",  asset: "BTC",  maturityDays: 60, baseNoteSizeUsd: 10000, baseline: 0.985, seed: 402 },
    { symbol: "JUP-14D",  asset: "JUP",  maturityDays: 14, baseNoteSizeUsd: 500, baseline: 0.960, seed: 501 },
    { symbol: "BONK-7D",  asset: "BONK", maturityDays: 7,  baseNoteSizeUsd: 250, baseline: 0.945, seed: 601 },
    { symbol: "WIF-21D",  asset: "WIF",  maturityDays: 21, baseNoteSizeUsd: 500, baseline: 0.965, seed: 701 },
    { symbol: "RAY-30D",  asset: "RAY",  maturityDays: 30, baseNoteSizeUsd: 500, baseline: 0.968, seed: 801 },
    { symbol: "ORCA-14D", asset: "ORCA", maturityDays: 14, baseNoteSizeUsd: 500, baseline: 0.962, seed: 901 },
    { symbol: "PYTH-45D", asset: "PYTH", maturityDays: 45, baseNoteSizeUsd: 500, baseline: 0.972, seed: 1001 },
    { symbol: "JTO-30D",  asset: "JTO",  maturityDays: 30, baseNoteSizeUsd: 500, baseline: 0.966, seed: 1101 },
    { symbol: "HNT-60D",  asset: "HNT",  maturityDays: 60, baseNoteSizeUsd: 500, baseline: 0.978, seed: 1201 },
  ];

  for (const def of marketDefs) {
    const rng = mulberry32(def.seed);
    const candles = seedCandles(def.baseline, 48, rng);
    const last = candles[candles.length - 1].close;
    const first = candles[0].close;
    const change24hBps = Math.round(((last - first) / first) * 10000);
    const high24h = Math.max(...candles.slice(-24).map(c => c.high));
    const low24h = Math.min(...candles.slice(-24).map(c => c.low));
    const volume24hUsd = candles.slice(-24).reduce((s, c) => s + c.volumeUsd, 0);
    markets.push({
      symbol: def.symbol, asset: def.asset, maturityDays: def.maturityDays,
      baseNoteSizeUsd: def.baseNoteSizeUsd, lastPrice: last, change24hBps,
      volume24hUsd, high24h, low24h,
    });
    candlesByMarket[def.symbol] = candles;

    // Synthetic bid book: buyers wanting notes slightly below last price.
    bidsByMarket[def.symbol] = Array.from({ length: 6 }, (_, i) => ({
      priceBps: Math.round(Math.max(0.85, last - 0.005 - i * 0.003) * 10000),
      noteCount: Math.floor(2 + rng() * 18),
    }));
  }

  // Listings tied to markets.
  const seedListings: Array<Omit<NoteListing, "id" | "createdAt" | "status" | "faceValueUsd" | "yieldBps" | "askPriceUsd" | "discountBps"> & { priceFrac: number }> = [
    { seller: "MM-Arbitrage-01", noteCount: 5, noteSizeUsd: 1000, daysToMaturity: 30, privacy: "Umbra+Arcium", creditLineId: "F29HC…qnCP", market: "USDC-30D", priceFrac: 0.97 },
    { seller: "MM-Stat-Arb-07", noteCount: 10, noteSizeUsd: 1000, daysToMaturity: 30, privacy: "Arcium", creditLineId: "7Kp2R…9mXz", market: "USDC-30D", priceFrac: 0.96 },
    { seller: "MM-HFT-12", noteCount: 3, noteSizeUsd: 2500, daysToMaturity: 14, privacy: "Umbra", creditLineId: "Bq8Le…3tVw", market: "SOL-14D", priceFrac: 0.98 },
    { seller: "Treasury-Yield", noteCount: 4, noteSizeUsd: 5000, daysToMaturity: 90, privacy: "Umbra+Arcium", creditLineId: "Hc4Wn…1kRp", market: "USDC-90D", priceFrac: 0.955 },
    { seller: "MM-Basis-09", noteCount: 6, noteSizeUsd: 2000, daysToMaturity: 45, privacy: "MagicBlock", creditLineId: "P9mKq…8nDf", market: "ETH-45D", priceFrac: 0.972 },
    { seller: "Whales-Treasury", noteCount: 2, noteSizeUsd: 10000, daysToMaturity: 60, privacy: "Umbra+Arcium", creditLineId: "R8sLm…4kQw", market: "BTC-60D", priceFrac: 0.988 },
  ];
  for (const s of seedListings) {
    const faceValueUsd = s.noteCount * s.noteSizeUsd;
    const askPriceUsd = Math.round(faceValueUsd * s.priceFrac);
    const discountBps = Math.round((1 - s.priceFrac) * 10000);
    const yieldBps = annualizedYield(s.noteCount, s.noteSizeUsd, askPriceUsd, s.daysToMaturity);
    listings.push({
      seller: s.seller, noteCount: s.noteCount, noteSizeUsd: s.noteSizeUsd,
      faceValueUsd, askPriceUsd, discountBps, yieldBps, daysToMaturity: s.daysToMaturity,
      privacy: s.privacy, creditLineId: s.creditLineId, market: s.market,
      id: `lst_${(listings.length + 1).toString().padStart(4, "0")}`,
      createdAt: now - Math.floor(Math.random() * 600000), status: "active",
    });
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function annualizedYield(noteCount: number, noteSizeUsd: number, askPriceUsd: number, daysToMaturity: number): number {
  const faceValueUsd = noteCount * noteSizeUsd;
  if (askPriceUsd <= 0 || daysToMaturity <= 0) return 0;
  return Math.round(((faceValueUsd - askPriceUsd) / askPriceUsd) * (365 / daysToMaturity) * 10000);
}

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export function getListings(status?: "active" | "filled" | "cancelled"): NoteListing[] {
  ensureSeeded();
  const all = [...listings].sort((a, b) => b.createdAt - a.createdAt);
  return status ? all.filter(l => l.status === status) : all;
}

export function getListing(id: string): NoteListing | undefined {
  ensureSeeded();
  return listings.find(l => l.id === id);
}

export interface CreateListingInput {
  seller: string;
  noteCount: number;
  noteSizeUsd: number;
  askPriceUsd: number;
  daysToMaturity: number;
  privacy: PrivacyPolicyLabel;
  creditLineId: string;
  market: string;
}

export function createListing(input: CreateListingInput): NoteListing {
  ensureSeeded();
  const faceValueUsd = input.noteCount * input.noteSizeUsd;
  const discountBps = Math.max(0, Math.round(((faceValueUsd - input.askPriceUsd) / faceValueUsd) * 10000));
  const listing: NoteListing = {
    id: `lst_${(listings.length + 1).toString().padStart(4, "0")}`,
    seller: input.seller,
    noteCount: input.noteCount,
    noteSizeUsd: input.noteSizeUsd,
    faceValueUsd,
    askPriceUsd: input.askPriceUsd,
    discountBps,
    yieldBps: annualizedYield(input.noteCount, input.noteSizeUsd, input.askPriceUsd, input.daysToMaturity),
    daysToMaturity: input.daysToMaturity,
    privacy: input.privacy,
    creditLineId: input.creditLineId,
    market: markets.some(m => m.symbol === input.market) ? input.market : "USDC-30D",
    createdAt: Date.now(),
    status: "active",
  };
  listings.unshift(listing);
  return listing;
}

export function cancelListing(id: string, seller: string): boolean {
  ensureSeeded();
  const listing = listings.find(l => l.id === id);
  if (!listing || listing.seller !== seller || listing.status !== "active") return false;
  listing.status = "cancelled";
  return true;
}

export interface BuyInput {
  listingId: string;
  buyer: string;
  settlementId: string;
}

export function fillListing(input: BuyInput): Trade | { error: string } {
  ensureSeeded();
  const listing = listings.find(l => l.id === input.listingId);
  if (!listing) return { error: "Listing not found" };
  if (listing.status !== "active") return { error: "Listing no longer active" };
  listing.status = "filled";
  const trade: Trade = {
    id: `trd_${(trades.length + 1).toString().padStart(4, "0")}`,
    listingId: listing.id,
    buyer: input.buyer,
    seller: listing.seller,
    noteCount: listing.noteCount,
    faceValueUsd: listing.faceValueUsd,
    priceUsd: listing.askPriceUsd,
    discountBps: listing.discountBps,
    settlementId: input.settlementId,
    timestamp: Date.now(),
  };
  trades.unshift(trade);
  // Update the market's last price and append a candle tick.
  const market = markets.find(m => m.symbol === listing.market);
  if (market) {
    const priceFrac = listing.faceValueUsd > 0 ? listing.askPriceUsd / listing.faceValueUsd : market.lastPrice;
    market.lastPrice = priceFrac;
    market.volume24hUsd += listing.askPriceUsd;
    market.high24h = Math.max(market.high24h, priceFrac);
    market.low24h = Math.min(market.low24h, priceFrac);
    const series = candlesByMarket[market.symbol] ?? [];
    const last = series[series.length - 1];
    if (last) {
      last.close = priceFrac;
      last.high = Math.max(last.high, priceFrac);
      last.low = Math.min(last.low, priceFrac);
      last.volumeUsd += listing.askPriceUsd;
    }
  }
  return trade;
}

export function getTrades(limit = 20, market?: string): Trade[] {
  ensureSeeded();
  const all = market ? trades.filter(t => {
    const l = listings.find(x => x.id === t.listingId);
    return l?.market === market;
  }) : trades;
  return all.slice(0, limit);
}

/* ------------------------------------------------------------------ */
/*  Markets / chart data / order book                                  */
/* ------------------------------------------------------------------ */

export function getMarkets(): Market[] {
  ensureSeeded();
  return markets;
}

export function getMarket(symbol: string): Market | undefined {
  ensureSeeded();
  return markets.find(m => m.symbol === symbol);
}

export function getCandles(symbol: string, limit = 48): Candle[] {
  ensureSeeded();
  return (candlesByMarket[symbol] ?? []).slice(-limit);
}

export interface OrderBookLevel {
  priceBps: number;   // price as fraction of face, in bps
  notes: number;
  total: number;      // cumulative notes
  faceUsd: number;
}

export interface OrderBook {
  market: string;
  asks: OrderBookLevel[]; // sell listings, ascending price
  bids: OrderBookLevel[]; // buy orders, descending price
}

/** Build an aggregated order book for a market from active listings (asks) + synthetic bids. */
export function getOrderBook(symbol: string): OrderBook {
  ensureSeeded();
  const market = markets.find(m => m.symbol === symbol);
  const baseNoteSize = market?.baseNoteSizeUsd ?? 1000;

  // Asks: group active listings in this market by price level.
  const active = listings.filter(l => l.status === "active" && l.market === symbol);
  const askMap: Record<number, number> = {};
  for (const l of active) {
    const priceBps = l.faceValueUsd > 0 ? Math.round((l.askPriceUsd / l.faceValueUsd) * 10000) : 10000;
    askMap[priceBps] = (askMap[priceBps] ?? 0) + l.noteCount;
  }
  const askLevels: OrderBookLevel[] = Object.entries(askMap)
    .map(([bps, notes]) => ({ priceBps: Number(bps), notes, total: 0, faceUsd: notes * baseNoteSize }))
    .sort((a, b) => a.priceBps - b.priceBps);
  let askCum = 0;
  for (const lv of askLevels) { askCum += lv.notes; lv.total = askCum; }

  // Bids: from the synthetic bid book.
  const rawBids = bidsByMarket[symbol] ?? [];
  const bidLevels: OrderBookLevel[] = rawBids
    .map(b => ({ priceBps: b.priceBps, notes: b.noteCount, total: 0, faceUsd: b.noteCount * baseNoteSize }))
    .sort((a, b) => b.priceBps - a.priceBps);
  let bidCum = 0;
  for (const lv of bidLevels) { bidCum += lv.notes; lv.total = bidCum; }

  return { market: symbol, asks: askLevels, bids: bidLevels };
}

export interface ExchangeStats {
  activeListings: number;
  totalNotesListed: number;
  totalFaceValueUsd: number;
  tradeCount: number;
  totalVolumeUsd: number;
  avgDiscountBps: number;
  bestYieldBps: number;
}

export function getStats(): ExchangeStats {
  ensureSeeded();
  const active = listings.filter(l => l.status === "active");
  const filled = trades;
  return {
    activeListings: active.length,
    totalNotesListed: active.reduce((s, l) => s + l.noteCount, 0),
    totalFaceValueUsd: active.reduce((s, l) => s + l.faceValueUsd, 0),
    tradeCount: filled.length,
    totalVolumeUsd: filled.reduce((s, t) => s + t.priceUsd, 0),
    avgDiscountBps: active.length ? Math.round(active.reduce((s, l) => s + l.discountBps, 0) / active.length) : 0,
    bestYieldBps: active.reduce((m, l) => Math.max(m, l.yieldBps), 0),
  };
}

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
  createdAt: number;
  status: "active" | "filled" | "cancelled";
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
let seeded = false;

/** Seed realistic-looking market-maker listings on first access. */
function ensureSeeded(): void {
  if (seeded) return;
  seeded = true;
  const now = Date.now();
  const seeds: Array<Omit<NoteListing, "id" | "createdAt" | "status" | "faceValueUsd" | "yieldBps">> = [
    { seller: "MM-Arbitrage-01", noteCount: 5, noteSizeUsd: 1000, askPriceUsd: 4850, discountBps: 300, daysToMaturity: 30, privacy: "Umbra+Arcium", creditLineId: "F29HC…qnCP" },
    { seller: "MM-Stat-Arb-07", noteCount: 10, noteSizeUsd: 1000, askPriceUsd: 9600, discountBps: 400, daysToMaturity: 45, privacy: "Arcium", creditLineId: "7Kp2R…9mXz" },
    { seller: "MM-HFT-12", noteCount: 3, noteSizeUsd: 2500, askPriceUsd: 7350, discountBps: 200, daysToMaturity: 14, privacy: "Umbra", creditLineId: "Bq8Le…3tVw" },
    { seller: "Treasury-Yield", noteCount: 20, noteSizeUsd: 5000, askPriceUsd: 97000, discountBps: 300, daysToMaturity: 90, privacy: "Umbra+Arcium", creditLineId: "Hc4Wn…1kRp" },
    { seller: "MM-Basis-09", noteCount: 8, noteSizeUsd: 1000, askPriceUsd: 7800, discountBps: 250, daysToMaturity: 60, privacy: "MagicBlock", creditLineId: "P9mKq…8nDf" },
  ];
  for (const s of seeds) {
    const faceValueUsd = s.noteCount * s.noteSizeUsd;
    // Annualized yield = discount / price * (365 / days).
    const yieldBps = Math.round(((faceValueUsd - s.askPriceUsd) / s.askPriceUsd) * (365 / s.daysToMaturity) * 10000);
    listings.push({ ...s, id: `lst_${(listings.length + 1).toString().padStart(4, "0")}`, faceValueUsd, yieldBps, createdAt: now - Math.floor(Math.random() * 600000), status: "active" });
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
  return trade;
}

export function getTrades(limit = 20): Trade[] {
  ensureSeeded();
  return trades.slice(0, limit);
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

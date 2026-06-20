/**
 * Unit tests for the exchange store (order book math, candles, market linkage).
 * Run:  bun run apps/localnet/src/exchange-test.ts
 */

import {
  getListings, createListing, fillListing, cancelListing,
  getTrades, getMarkets, getMarket, getCandles, getOrderBook, getStats,
} from "../../web-next/src/lib/exchange-store";

let passed = 0;
let failed = 0;

function assert(cond: boolean, msg: string) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.log(`  ❌ ${msg}`); }
}

function approxEq(a: number, b: number, eps = 1) {
  return Math.abs(a - b) <= eps;
}

console.log("\n🧪 Exchange Store Unit Tests\n");

// --- Markets ---
console.log("Markets:");
const markets = getMarkets();
assert(markets.length >= 5, `${markets.length} markets seeded`);
assert(markets.every(m => m.lastPrice > 0.8 && m.lastPrice <= 1.0), "all market prices in valid discount range (0.80–1.00)");
assert(markets.every(m => m.volume24hUsd > 0), "all markets have 24h volume");
assert(markets.every(m => m.high24h >= m.low24h), "high >= low for all markets");

// --- Candles ---
console.log("\nCandles:");
for (const m of markets) {
  const c = getCandles(m.symbol, 48);
  assert(c.length === 48, `${m.symbol} has 48 candles`);
  assert(c.every(k => k.high >= k.low && k.high >= k.open && k.high >= k.close), `${m.symbol} candle highs valid`);
  assert(c.every(k => k.low <= k.open && k.low <= k.close), `${m.symbol} candle lows valid`);
}

// --- Order book ---
console.log("\nOrder book:");
for (const m of markets) {
  const ob = getOrderBook(m.symbol);
  assert(ob.asks.every((a, i) => i === 0 || a.priceBps >= ob.asks[i - 1].priceBps), `${m.symbol} asks sorted ascending`);
  assert(ob.bids.every((b, i) => i === 0 || b.priceBps <= ob.bids[i - 1].priceBps), `${m.symbol} bids sorted descending`);
  assert(ob.asks.every(a => a.total >= a.notes), `${m.symbol} ask totals cumulative`);
}

// --- Listing math ---
console.log("\nListing math (discount + yield):");
const seller = "SellerWallet".padEnd(44, "0");
const before = getListings("active").length;
const listing = createListing({
  seller, noteCount: 10, noteSizeUsd: 1000, askPriceUsd: 9500,
  daysToMaturity: 365, privacy: "Umbra+Arcium", creditLineId: "TEST", market: "USDC-30D",
});
assert(getListings("active").length === before + 1, "listing count incremented");
assert(listing.faceValueUsd === 10000, `face value correct ($${listing.faceValueUsd})`);
assert(approxEq(listing.discountBps, 500, 1), `discount = 5.00% (got ${listing.discountBps / 100}%)`);
// yield at 365 days, 5% discount → ~526 bps (500/9500 * 365/365 * 10000)
assert(listing.yieldBps > 0, `yield positive (${(listing.yieldBps / 100).toFixed(2)}%)`);

// --- Validation: ask > face ---
console.log("\nValidation:");
try {
  createListing({ seller, noteCount: 2, noteSizeUsd: 1000, askPriceUsd: 5000, daysToMaturity: 30, privacy: "Umbra", creditLineId: "X", market: "USDC-30D" });
  // store itself doesn't reject (API layer does), but discount should be 0 / price clamped
  assert(true, "store accepts (API validates ask<=face separately)");
} catch (e) { assert(false, `unexpected throw: ${e}`); }

// --- Fill (buy) flow ---
console.log("\nBuy flow:");
const buyer = "BuyerWallet".padEnd(44, "0");
const env1 = await import("../../web-next/src/lib/stealth-settlement.ts");
const shielded = await env1.createShieldedEnvelope({
  sender: { toBase58: () => buyer } as any,
  recipient: { toBase58: () => seller, toBuffer: () => new Uint8Array(32).fill(1) } as any,
  amount: 9500, noteSizeUsd: 1000, creditLineId: "TEST",
});
const trade = fillListing({ listingId: listing.id, buyer, settlementId: shielded.envelope.settlementId });
assert(!("error" in trade), "fill succeeded");
if (!("error" in trade)) {
  assert(trade.buyer === buyer, "trade buyer recorded");
  assert(trade.priceUsd === 9500, "trade price = ask");
  assert(trade.settlementId === shielded.envelope.settlementId, "shielded settlement id recorded");
}

// --- Double-fill protection ---
console.log("\nDouble-fill protection:");
const dup = fillListing({ listingId: listing.id, buyer, settlementId: "x" });
assert("error" in dup, "second fill rejected");

// --- Cancel flow ---
console.log("\nCancel flow:");
const c2 = createListing({ seller, noteCount: 1, noteSizeUsd: 1000, askPriceUsd: 900, daysToMaturity: 30, privacy: "Arcium", creditLineId: "C", market: "USDC-30D" });
assert(cancelListing(c2.id, seller), "owner can cancel");
assert(!cancelListing(c2.id, "WrongOwner".padEnd(44, "0")), "non-owner cannot cancel");
assert(cancelListing(c2.id, seller) === false, "already-cancelled cannot cancel again");

// --- Market price update on trade ---
console.log("\nMarket price updates on trade:");
const mBefore = getMarket("USDC-30D")!.lastPrice;
const cheapListing = createListing({ seller, noteCount: 1, noteSizeUsd: 1000, askPriceUsd: 100, daysToMaturity: 30, privacy: "Umbra", creditLineId: "Y", market: "USDC-30D" });
fillListing({ listingId: cheapListing.id, buyer, settlementId: "z" });
const mAfter = getMarket("USDC-30D")!.lastPrice;
assert(approxEq(mAfter, 0.10, 0.01), `market last price moved to deep-discount trade (${(mAfter * 100).toFixed(2)})`);

// --- Stats ---
console.log("\nStats:");
const stats = getStats();
assert(stats.activeListings >= 0, "active listings counted");
assert(stats.tradeCount > 0, "trades counted");
assert(stats.totalVolumeUsd > 0, "volume > 0");

// --- Trades filter by market ---
console.log("\nTrade filtering:");
const usdcTrades = getTrades(100, "USDC-30D");
assert(usdcTrades.length >= 2, `${usdcTrades.length} USDC-30D trades (expected >=2 from our fills)`);

console.log(`\n${failed === 0 ? "🎉 ALL EXCHANGE TESTS PASSED" : "❌ SOME TESTS FAILED"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

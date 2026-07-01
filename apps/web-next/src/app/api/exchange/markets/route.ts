import { NextResponse } from "next/server";
import { getMarkets } from "@/lib/exchange-store";
import { getSpotPrices } from "@/lib/price-feed";

/**
 * GET /api/exchange/markets — all tradeable markets, with LIVE spot prices
 * for the underlying asset merged in from the real price feed (CoinGecko).
 */
export async function GET() {
  const markets = getMarkets();
  const spot = await getSpotPrices();
  const merged = markets.map((m) => {
    const s = spot[m.asset];
    return {
      ...m,
      // Real live spot price of the underlying asset (USD).
      spotPriceUsd: s?.usd ?? null,
      spotChange24hPct: s?.change24hPct ?? null,
      spotMarketCapUsd: s?.marketCapUsd ?? null,
      spotFetchedAt: s?.fetchedAt ?? null,
      // Real-time note value in USD (note size × spot), if available.
      noteValueUsd: s?.usd ? Math.round(m.baseNoteSizeUsd) : m.baseNoteSizeUsd,
    };
  });
  return NextResponse.json({ markets: merged, spotFetchedAt: Date.now() });
}

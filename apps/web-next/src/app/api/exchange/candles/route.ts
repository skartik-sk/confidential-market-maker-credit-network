import { NextRequest, NextResponse } from "next/server";
import { getMarket } from "@/lib/exchange-store";
import { getOhlc } from "@/lib/price-feed";

/**
 * GET /api/exchange/candles?market=USDC-30D&days=7
 *
 * Returns REAL OHLC candles for the market's underlying asset (from the live
 * price feed), not synthetic data. The chart shows the actual asset's price
 * action. The note discount mechanic is layered on top client-side.
 */
export async function GET(request: NextRequest) {
  const symbol = request.nextUrl.searchParams.get("market") ?? "USDC-30D";
  const daysParam = request.nextUrl.searchParams.get("days");
  const days = daysParam ? Math.min(Math.max(1, Number(daysParam) || 7), 30) : 7;

  const market = getMarket(symbol);
  const asset = market?.asset ?? "SOL";
  const candles = await getOhlc(asset, days);

  return NextResponse.json({
    market: symbol,
    asset,
    source: candles.length ? "coingecko-live" : "unavailable",
    candles,
    fetchedAt: Date.now(),
  });
}

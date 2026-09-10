import { NextRequest, NextResponse } from "next/server";
import { getMarket } from "@/lib/exchange-store";
import { getOhlc } from "@/lib/price-feed";
import { rateLimitRequest, cleanStr } from "@/lib/api-guard";

/**
 * GET /api/exchange/candles?market=USDC-30D&days=7
 *
 * Returns REAL OHLC candles for the market's underlying asset (from the live
 * price feed), not synthetic data. The chart shows the actual asset's price
 * action. The note discount mechanic is layered on top client-side.
 */
export async function GET(request: NextRequest) {
  if (!rateLimitRequest(request, "GET")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  const symbol = cleanStr(request.nextUrl.searchParams.get("market"), 32) || "USDC-30D";
  const daysParam = cleanStr(request.nextUrl.searchParams.get("days"), 8);
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

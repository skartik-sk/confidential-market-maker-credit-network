import { NextRequest, NextResponse } from "next/server";
import { getOrderBook } from "@/lib/exchange-store";
import { rateLimitRequest, cleanStr } from "@/lib/api-guard";

/** GET /api/exchange/orderbook?market=USDC-30D — aggregated bids/asks */
export async function GET(request: NextRequest) {
  if (!rateLimitRequest(request, "GET")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  const market = cleanStr(request.nextUrl.searchParams.get("market"), 32) || "USDC-30D";
  return NextResponse.json(getOrderBook(market));
}

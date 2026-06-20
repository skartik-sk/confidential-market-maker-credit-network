import { NextRequest, NextResponse } from "next/server";
import { getOrderBook } from "@/lib/exchange-store";

/** GET /api/exchange/orderbook?market=USDC-30D — aggregated bids/asks */
export async function GET(request: NextRequest) {
  const market = request.nextUrl.searchParams.get("market") ?? "USDC-30D";
  return NextResponse.json(getOrderBook(market));
}

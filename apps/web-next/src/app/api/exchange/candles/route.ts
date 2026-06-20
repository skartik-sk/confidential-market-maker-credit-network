import { NextRequest, NextResponse } from "next/server";
import { getCandles } from "@/lib/exchange-store";

/** GET /api/exchange/candles?market=USDC-30D&limit=48 — OHLC price history */
export async function GET(request: NextRequest) {
  const market = request.nextUrl.searchParams.get("market") ?? "USDC-30D";
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, Number(limitParam) || 48), 200) : 48;
  return NextResponse.json({ market, candles: getCandles(market, limit) });
}

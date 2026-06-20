import { NextRequest, NextResponse } from "next/server";
import { getTrades } from "@/lib/exchange-store";

/** GET /api/exchange/trades[?limit=20] */
export async function GET(request: NextRequest) {
  const limitParam = request.nextUrl.searchParams.get("limit");
  const limit = limitParam ? Math.min(Math.max(1, Number(limitParam) || 20), 100) : 20;
  return NextResponse.json({ trades: getTrades(limit) });
}

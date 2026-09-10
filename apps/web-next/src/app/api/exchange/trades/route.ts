import { NextRequest, NextResponse } from "next/server";
import { getTrades } from "@/lib/exchange-store";
import { rateLimitRequest, cleanStr } from "@/lib/api-guard";

/** GET /api/exchange/trades[?limit=20] */
export async function GET(request: NextRequest) {
  if (!rateLimitRequest(request, "GET")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  const limitParam = cleanStr(request.nextUrl.searchParams.get("limit"), 8);
  const limit = limitParam ? Math.min(Math.max(1, Number(limitParam) || 20), 100) : 20;
  return NextResponse.json({ trades: getTrades(limit) });
}

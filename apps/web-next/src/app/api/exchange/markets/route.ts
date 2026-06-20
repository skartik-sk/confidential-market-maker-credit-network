import { NextResponse } from "next/server";
import { getMarkets } from "@/lib/exchange-store";

/** GET /api/exchange/markets — all tradeable markets */
export async function GET() {
  return NextResponse.json({ markets: getMarkets() });
}

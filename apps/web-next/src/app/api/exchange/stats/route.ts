import { NextResponse } from "next/server";
import { getStats } from "@/lib/exchange-store";

/** GET /api/exchange/stats — aggregate exchange statistics */
export async function GET() {
  return NextResponse.json(getStats());
}

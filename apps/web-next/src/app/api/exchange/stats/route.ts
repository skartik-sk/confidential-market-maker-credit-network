import { NextRequest, NextResponse } from "next/server";
import { getStats } from "@/lib/exchange-store";
import { rateLimitRequest } from "@/lib/api-guard";

/** GET /api/exchange/stats — aggregate exchange statistics */
export async function GET(request: NextRequest) {
  if (!rateLimitRequest(request, "GET")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  return NextResponse.json(getStats());
}

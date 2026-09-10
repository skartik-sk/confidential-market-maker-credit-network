import { NextRequest, NextResponse } from "next/server";
import { fillListing } from "@/lib/exchange-store";
import { rateLimitRequest, requireAddress, cleanStr } from "@/lib/api-guard";

/** POST /api/exchange/buy — fill (buy) an active listing */
export async function POST(request: NextRequest) {
  if (!rateLimitRequest(request, "POST")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  try {
    const body = await request.json();
    const listingId = cleanStr(body.listingId, 64);
    const buyer = requireAddress(body.buyer);
    const settlementId = cleanStr(body.settlementId, 128);

    if (!listingId) {
      return NextResponse.json({ error: "listingId required" }, { status: 400 });
    }
    if (!buyer) {
      return NextResponse.json({ error: "Valid buyer address required" }, { status: 400 });
    }
    if (!settlementId) {
      return NextResponse.json({ error: "settlementId required (shielded settlement)" }, { status: 400 });
    }

    const result = fillListing({ listingId, buyer, settlementId });
    if ("error" in result) {
      // 404 = the listing doesn't exist (e.g. a serverless cold start wiped the
      // in-memory store); 409 = it exists but was already filled.
      const status = result.error.includes("not found") ? 404 : 409;
      return NextResponse.json({ error: result.error }, { status });
    }
    return NextResponse.json({ trade: result }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid request" }, { status: 400 });
  }
}

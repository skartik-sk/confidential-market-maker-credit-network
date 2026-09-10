import { NextRequest, NextResponse } from "next/server";
import { cancelListing } from "@/lib/exchange-store";
import { rateLimitRequest, requireAddress, cleanStr } from "@/lib/api-guard";

/** POST /api/exchange/cancel — cancel one of your own active listings */
export async function POST(request: NextRequest) {
  if (!rateLimitRequest(request, "POST")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  try {
    const body = await request.json();
    const listingId = cleanStr(body.listingId, 64);
    const seller = requireAddress(body.seller);
    if (!listingId || !seller) {
      return NextResponse.json({ error: "listingId and valid seller required" }, { status: 400 });
    }
    const ok = cancelListing(listingId, seller);
    if (!ok) {
      return NextResponse.json({ error: "Could not cancel (not found, not yours, or not active)" }, { status: 409 });
    }
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid request" }, { status: 400 });
  }
}

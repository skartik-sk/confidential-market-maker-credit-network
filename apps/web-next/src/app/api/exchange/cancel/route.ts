import { NextRequest, NextResponse } from "next/server";
import { cancelListing } from "@/lib/exchange-store";

/** POST /api/exchange/cancel — cancel one of your own active listings */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const listingId = String(body.listingId ?? "").trim();
    const seller = String(body.seller ?? "").trim();
    if (!listingId || seller.length < 32) {
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

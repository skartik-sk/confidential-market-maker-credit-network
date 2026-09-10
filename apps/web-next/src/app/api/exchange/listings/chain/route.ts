import { NextRequest, NextResponse } from "next/server";
import { recordListingChainSig } from "@/lib/exchange-store";
import { rateLimitRequest, cleanStr } from "@/lib/api-guard";

/** POST /api/exchange/listings/chain — attach the devnet memo signature that
 *  recorded an ask on-chain. Only non-demo listings can carry a signature. */
export async function POST(request: NextRequest) {
  if (!rateLimitRequest(request, "POST")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  try {
    const body = await request.json();
    const listingId = cleanStr(body?.listingId, 64);
    const chainSig = cleanStr(body?.chainSig, 128);
    if (!listingId || chainSig.length < 32) {
      return NextResponse.json({ error: "listingId and a valid chainSig required" }, { status: 400 });
    }
    const ok = recordListingChainSig(listingId, chainSig);
    if (!ok) return NextResponse.json({ error: "listing not found or demo" }, { status: 409 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
}

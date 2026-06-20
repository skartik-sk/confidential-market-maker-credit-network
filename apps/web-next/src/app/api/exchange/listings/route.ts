import { NextRequest, NextResponse } from "next/server";
import { getListings, createListing, type CreateListingInput, type PrivacyPolicyLabel } from "@/lib/exchange-store";

const VALID_PRIVACY: PrivacyPolicyLabel[] = ["Public", "Umbra", "Arcium", "Umbra+Arcium", "MagicBlock"];

/** GET /api/exchange/listings[?status=active] */
export async function GET(request: NextRequest) {
  const status = request.nextUrl.searchParams.get("status") as
    | "active"
    | "filled"
    | "cancelled"
    | null;
  return NextResponse.json({ listings: getListings(status ?? undefined) });
}

/** POST /api/exchange/listings — create a new listing */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const seller = String(body.seller ?? "").trim();
    if (seller.length < 32) {
      return NextResponse.json({ error: "Valid seller address required" }, { status: 400 });
    }
    const noteCount = Number(body.noteCount);
    const noteSizeUsd = Number(body.noteSizeUsd);
    const askPriceUsd = Number(body.askPriceUsd);
    const daysToMaturity = Number(body.daysToMaturity);
    const privacy = String(body.privacy) as PrivacyPolicyLabel;
    const creditLineId = String(body.creditLineId ?? "").trim();
    const market = String(body.market ?? "USDC-30D").trim();

    if (!Number.isInteger(noteCount) || noteCount <= 0) {
      return NextResponse.json({ error: "noteCount must be a positive integer" }, { status: 400 });
    }
    if (!(noteSizeUsd > 0)) {
      return NextResponse.json({ error: "noteSizeUsd must be positive" }, { status: 400 });
    }
    if (!(askPriceUsd > 0)) {
      return NextResponse.json({ error: "askPriceUsd must be positive" }, { status: 400 });
    }
    if (askPriceUsd > noteCount * noteSizeUsd) {
      return NextResponse.json({ error: "askPriceUsd cannot exceed face value" }, { status: 400 });
    }
    if (!(daysToMaturity > 0 && daysToMaturity <= 365)) {
      return NextResponse.json({ error: "daysToMaturity must be 1..365" }, { status: 400 });
    }
    if (!VALID_PRIVACY.includes(privacy)) {
      return NextResponse.json({ error: "Invalid privacy policy" }, { status: 400 });
    }

    const input: CreateListingInput = {
      seller,
      noteCount,
      noteSizeUsd,
      askPriceUsd,
      daysToMaturity,
      privacy,
      creditLineId: creditLineId || "—",
      market,
    };
    return NextResponse.json({ listing: createListing(input) }, { status: 201 });
  } catch (e: any) {
    return NextResponse.json({ error: e.message ?? "Invalid request" }, { status: 400 });
  }
}

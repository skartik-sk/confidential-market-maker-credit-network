import { NextResponse } from "next/server";
import { getDemoPrivateView } from "@/lib/demo-data";

/** GET /api/demo/credit-line/private — the PRIVATE view: raw note values and
 *  USD totals. Kept separate from the public credit-line response so values
 *  are never served by default.
 *
 *  DEMO ONLY: unauthenticated by design. In production this must verify a
 *  wallet signature (sign-in-with-Solana) and return 401 for callers who do
 *  not own the credit line. */
export async function GET() {
  return NextResponse.json(getDemoPrivateView());
}

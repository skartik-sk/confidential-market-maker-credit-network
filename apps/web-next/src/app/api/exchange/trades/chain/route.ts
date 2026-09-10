import { NextRequest, NextResponse } from "next/server";
import { recordTradePaymentSig } from "@/lib/exchange-store";
import { rateLimitRequest, cleanStr } from "@/lib/api-guard";

/** POST /api/exchange/trades/chain — attach the devnet signature of the real
 *  USDC payment that settled a trade on-chain. */
export async function POST(request: NextRequest) {
  if (!rateLimitRequest(request, "POST")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  try {
    const body = await request.json();
    const tradeId = cleanStr(body?.tradeId, 64);
    const paymentSig = cleanStr(body?.paymentSig, 128);
    if (!tradeId || paymentSig.length < 32) {
      return NextResponse.json({ error: "tradeId and a valid paymentSig required" }, { status: 400 });
    }
    const ok = recordTradePaymentSig(tradeId, paymentSig);
    if (!ok) return NextResponse.json({ error: "trade not found" }, { status: 409 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
}

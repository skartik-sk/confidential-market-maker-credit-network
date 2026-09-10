import { NextRequest, NextResponse } from "next/server";
import { recordTradePaymentSig } from "@/lib/exchange-store";

/** POST /api/exchange/trades/chain — attach the devnet signature of the real
 *  USDC payment that settled a trade on-chain. */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const tradeId = String(body?.tradeId ?? "").trim();
    const paymentSig = String(body?.paymentSig ?? "").trim();
    if (!tradeId || !paymentSig || paymentSig.length < 32) {
      return NextResponse.json({ error: "tradeId and a valid paymentSig required" }, { status: 400 });
    }
    const ok = recordTradePaymentSig(tradeId, paymentSig);
    if (!ok) return NextResponse.json({ error: "trade not found" }, { status: 409 });
    return NextResponse.json({ ok: true }, { status: 200 });
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
}

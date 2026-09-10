import { NextRequest, NextResponse } from "next/server";
import { Connection, MessageV0, type VersionedTransactionResponse } from "@solana/web3.js";
import { getTradeById, markTradePaymentVerified } from "@/lib/exchange-store";
import { rateLimitRequest, cleanStr } from "@/lib/api-guard";

/**
 * POST /api/exchange/trades/verify — verify ON-CHAIN that a trade's USDC
 * payment actually happened on devnet.
 *
 * The buy payment includes a Memo instruction:
 *   MUTE:buy:<market>:<listingId>:<commitment16>:<settlementId12>
 * We fetch the payment tx from devnet, require it succeeded, and search the
 * memo program instructions for the trade's settlementId prefix.
 */

const DEVNET_RPC = "https://api.devnet.solana.com";
const MEMO_PROGRAM_ID = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";

const B58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Minimal base58 decoder (no extra deps). Returns null on invalid input. */
function base58Decode(s: string): Uint8Array | null {
  if (!s.length) return null;
  const digits: number[] = []; // little-endian
  for (let i = 0; i < s.length; i++) {
    const val = B58_ALPHABET.indexOf(s[i]);
    if (val < 0) return null;
    let carry = val;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] * 58;
      digits[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      digits.push(carry & 0xff);
      carry >>= 8;
    }
  }
  let zeros = 0;
  while (zeros < s.length && s[zeros] === "1") zeros++;
  const out = new Uint8Array(zeros + digits.length);
  for (let i = 0; i < digits.length; i++) out[zeros + i] = digits[digits.length - 1 - i];
  return out;
}

/** Text of every memo-program instruction in the tx (top-level only). */
function memoTexts(tx: VersionedTransactionResponse): string[] {
  const message = tx.transaction.message;
  const decoder = new TextDecoder("utf-8", { fatal: false });
  const texts: string[] = [];

  if (message instanceof MessageV0) {
    // v0: merge ALT-loaded keys so programIdIndex resolves correctly.
    const keys = message.getAccountKeys(
      tx.meta?.loadedAddresses
        ? { accountKeysFromLookups: tx.meta.loadedAddresses }
        : undefined,
    );
    for (const ix of message.compiledInstructions) {
      if (keys.get(ix.programIdIndex)?.toBase58() !== MEMO_PROGRAM_ID) continue;
      texts.push(decoder.decode(ix.data)); // already base58-decoded by web3.js
    }
  } else {
    // Legacy message: instructions carry base58-encoded data strings.
    const keys = message.getAccountKeys();
    for (const ix of message.instructions) {
      if (keys.get(ix.programIdIndex)?.toBase58() !== MEMO_PROGRAM_ID) continue;
      const bytes = base58Decode(ix.data);
      if (bytes) texts.push(decoder.decode(bytes));
    }
  }
  return texts;
}

const SIG_RE = /^[1-9A-HJ-NP-Za-km-z]{32,88}$/;

/** POST /api/exchange/trades/verify { tradeId, paymentSig } */
export async function POST(request: NextRequest) {
  if (!rateLimitRequest(request, "POST")) {
    return NextResponse.json({ error: "rate limited" }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid request" }, { status: 400 });
  }
  const payload = (body ?? {}) as Record<string, unknown>;
  const tradeId = cleanStr(payload.tradeId, 64);
  const paymentSig = cleanStr(payload.paymentSig, 128);
  if (!tradeId || !SIG_RE.test(paymentSig)) {
    return NextResponse.json({ error: "tradeId and a valid paymentSig required" }, { status: 400 });
  }

  const trade = getTradeById(tradeId);
  if (!trade) {
    return NextResponse.json({ error: "trade not found" }, { status: 404 });
  }

  try {
    const connection = new Connection(DEVNET_RPC, "confirmed");
    const tx = await connection.getTransaction(paymentSig, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx) {
      return NextResponse.json({ verified: false, reason: "transaction not found on devnet" });
    }
    if (tx.meta?.err) {
      return NextResponse.json({ verified: false, reason: "transaction failed on-chain" });
    }

    const needle = trade.settlementId.slice(0, 12);
    const memo = memoTexts(tx).find((t) => t.includes(needle));
    if (!memo) {
      return NextResponse.json({
        verified: false,
        reason: "settlement memo not found in payment transaction",
      });
    }

    markTradePaymentVerified(trade.id);
    return NextResponse.json({ verified: true });
  } catch {
    // RPC unreachable / malformed response — never fail hard, report softly.
    return NextResponse.json({ verified: false, reason: "rpc-unreachable" });
  }
}

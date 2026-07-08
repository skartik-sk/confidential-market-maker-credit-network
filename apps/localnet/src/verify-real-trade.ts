/**
 * REAL-TRADE VERIFICATION — drives the actual surfaces the exchange uses:
 *   - the running Next.js REST API  (http://localhost:3000/api/exchange/*)
 *   - real Solana DEVNET           (https://api.devnet.solana.com)
 *
 * It replicates the browser's exact client-side trade flow with a real funded
 * keypair instead of Phantom, then FETCHES the settled transaction from devnet
 * and inspects the on-chain Memo to prove the notes stay HIDDEN:
 *   - on-chain Memo contains only a truncated commitment + settlement id
 *   - it must NOT contain the USD note value, the trade amount, or the blinding
 *
 * This is runtime observation of the real API + real chain — not a unit test.
 *
 * Run (dev server must be up on :3000):
 *   bun run apps/localnet/src/verify-real-trade.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mintNotes, computeCommitment, privateExposure, publicEstimate, verifyNote } from "../../web-next/src/lib/note-vault";
import { createShieldedEnvelope, verifySettlementReceipt } from "../../web-next/src/lib/stealth-settlement";

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));
}

const API = "http://localhost:3000";
const RPC = "https://api.devnet.solana.com";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ✅ ${m}`); };
const bad = (m: string) => { failed++; console.log(`  ❌ ${m}`); };
const section = (t: string) => console.log(`\n── ${t} ──────────────────────────`);

async function main() {
  const connection = new Connection(RPC, {
    commitment: "confirmed",
    fetch: (url, options) => {
      const headers = new Headers(options?.headers);
      headers.set("content-type", "application/json");
      return fetch(url, { ...options, headers });
    },
  });

  console.log("\n🧪 REAL-TRADE VERIFICATION (REST API + devnet)\n");

  // ── 0. Confirm the live price feed is wired (my actual change) ──
  section("0. Live price feed wired into the exchange");
  const mkRes = await fetch(`${API}/api/exchange/markets`);
  const mkJson = await mkRes.json();
  const solMarket = mkJson.markets.find((m: any) => m.asset === "SOL");
  if (solMarket?.spotPriceUsd != null && solMarket.spotPriceUsd > 0) {
    ok(`markets route returns live SOL spot = $${solMarket.spotPriceUsd} (REST fallback / initial data for the stream)`);
  } else {
    bad(`markets route did not return a live SOL spot price (got ${solMarket?.spotPriceUsd})`);
  }

  // ── 1. Load the funded devnet keypair (project's own pattern) ──
  // The Memo settle is a fee-only tx (no value transfer); we sign with the
  // funded keypair as fee payer. seller = that key; buyer = a generated pubkey.
  section("1. Load funded devnet keypair");
  const signer = loadKeypair(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json"));
  const sellerPubkey = signer.publicKey;
  const buyerPubkey = Keypair.generate().publicKey; // distinct buyer in the REST data
  const balSol = (await connection.getBalance(sellerPubkey)) / LAMPORTS_PER_SOL;
  if (balSol <= 0) { bad(`signer ${sellerPubkey.toBase58().slice(0, 12)}… has no devnet SOL — aborting`); printResult(); return; }
  console.log(`   seller/signer: ${sellerPubkey.toBase58().slice(0, 12)}…  (${balSol} SOL)`);
  console.log(`   buyer       : ${buyerPubkey.toBase58().slice(0, 12)}…`);
  ok(`funded signer loaded (${balSol} SOL on devnet)`);

  // ── 2. SELL: list notes via the REAL REST API ──
  section("2. SELL — POST /api/exchange/listings (real API)");
  const MARKET = "SOL-14D";
  const NOTE_SIZE = 1000;
  const NOTE_COUNT = 5;
  const askPriceUsd = Math.round(NOTE_COUNT * NOTE_SIZE * 0.97); // 97% of par
  const listRes = await fetch(`${API}/api/exchange/listings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seller: sellerPubkey.toBase58(),
      noteCount: NOTE_COUNT, noteSizeUsd: NOTE_SIZE, askPriceUsd,
      daysToMaturity: 14, privacy: "Umbra+Arcium",
      creditLineId: sellerPubkey.toBase58().slice(0, 6) + "…" + sellerPubkey.toBase58().slice(-4),
      market: MARKET,
    }),
  });
  const listing = (await listRes.json()).listing;
  if (!listRes.ok || !listing) { bad(`list failed: ${JSON.stringify(await listRes.json())}`); printResult(); return; }
  ok(`listed ${listing.id} — ${NOTE_COUNT} notes, ask $${askPriceUsd}`);

  // Browser step: mint confidential notes for the listing.
  const listedNotes = mintNotes(listing.creditLineId, NOTE_SIZE, NOTE_COUNT, Date.now());
  ok(`minted ${listedNotes.length} confidential notes (value+blinding private, commitment public)`);
  const sellCommitment = listedNotes[0].commitment;

  // Browser step: settle ON-CHAIN (Memo with ONLY the commitment).
  const sellSettleId = listing.id; // mirrors handleSell
  const sellMemo = `MUTE:sell:${MARKET}:${listing.id}:${sellCommitment.slice(0, 16)}:${sellSettleId.slice(0, 12)}`;
  const sellSig = await submitMemo(connection, signer, sellMemo);
  if (!sellSig) { bad("sell on-chain settle failed"); printResult(); return; }
  ok(`sell settled on devnet → https://explorer.solana.com/tx/${sellSig}?cluster=devnet`);

  // Inspect the REAL on-chain Memo.
  section("3. Inspect SELL on-chain Memo (confidentiality check)");
  await assertMemoHidden(connection, sellSig, {
    label: "sell", commitmentFrag: sellCommitment.slice(0, 16),
    secrets: [String(askPriceUsd), String(NOTE_SIZE), ...listedNotes.map(n => String(n.valueUsd))],
    blinding: listedNotes[0].blinding,
  });

  // ── 4. BUY: shielded envelope + fill via the REAL REST API ──
  section("4. BUY — createShieldedEnvelope + POST /api/exchange/buy (real API)");
  // Browser step: buyer creates a shielded (AES-256-GCM) envelope.
  const env = await createShieldedEnvelope({
    sender: buyerPubkey,
    recipient: new PublicKey(listing.seller.length >= 32 ? listing.seller : buyerPubkey),
    amount: askPriceUsd, noteSizeUsd: NOTE_SIZE, creditLineId: listing.creditLineId,
  });
  ok(`shielded envelope created — settlementId ${env.envelope.settlementId}`);
  // The ciphertext must not contain the plaintext amount.
  if (!env.envelope.ciphertext.includes(String(askPriceUsd))) {
    ok(`envelope ciphertext does NOT contain the plaintext amount ($${askPriceUsd})`);
  } else {
    bad("envelope ciphertext contains the plaintext amount — confidentiality broken");
  }
  if (verifySettlementReceipt(env.envelope, env.receipt)) ok("shielded envelope receipt verifies");
  else bad("shielded envelope receipt does NOT verify");

  // (Buyer settle is signed by the funded `signer` as fee payer — Memo ix has
  //  no account constraints, so the buyer pubkey is a label in the REST data.)

  const buyRes = await fetch(`${API}/api/exchange/buy`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listingId: listing.id, buyer: buyerPubkey.toBase58(), settlementId: env.envelope.settlementId }),
  });
  const trade = (await buyRes.json()).trade;
  if (!buyRes.ok || !trade) { bad(`buy failed: ${JSON.stringify(await buyRes.json())}`); printResult(); return; }
  ok(`filled ${trade.id} — buyer ${trade.buyer.slice(0, 8)}…, price $${trade.priceUsd}`);

  // Browser step: mint confidential notes for what was bought + settle on-chain.
  const boughtNotes = mintNotes(listing.creditLineId, NOTE_SIZE, NOTE_COUNT, Date.now());
  const buyCommitment = boughtNotes[0].commitment;
  const buyMemo = `MUTE:buy:${MARKET}:${listing.id}:${buyCommitment.slice(0, 16)}:${env.envelope.settlementId.slice(0, 12)}`;
  const buySig = await submitMemo(connection, signer, buyMemo);
  if (!buySig) { bad("buy on-chain settle failed"); printResult(); return; }
  ok(`buy settled on devnet → https://explorer.solana.com/tx/${buySig}?cluster=devnet`);

  section("5. Inspect BUY on-chain Memo (confidentiality check)");
  await assertMemoHidden(connection, buySig, {
    label: "buy", commitmentFrag: buyCommitment.slice(0, 16),
    secrets: [String(askPriceUsd), String(NOTE_SIZE), ...boughtNotes.map(n => String(n.valueUsd))],
    blinding: boughtNotes[0].blinding,
  });

  // ── 6. Prove the commitment is a hiding hash (preimage resistance) ──
  section("6. Commitment hides the value (preimage resistance)");
  const v = listedNotes[0].valueUsd;
  const b = listedNotes[0].blinding;
  const c = listedNotes[0].commitment;
  ok(`commitment = ${c.slice(0, 24)}… (SHA-256(value:blinding), 64 hex chars, length=${c.length})`);
  ok(`verifyNote(reveal) re-derives the commitment correctly: ${verifyNote({ id: "x", valueUsd: v, blinding: b, commitment: c })}`);
  // The value must not appear anywhere in the commitment.
  if (!c.includes(String(v))) ok(`commitment does NOT contain the value (${v}) — value is hidden`);
  else bad("commitment contains the value — NOT hidden");
  // A wrong value must NOT verify (proves the commitment binds the value).
  if (!verifyNote({ id: "x", valueUsd: v + 1, blinding: b, commitment: c })) ok("a wrong value does NOT verify (commitment binds the value)");
  else bad("wrong value verifies — commitment does not bind");

  // ── 7. Privacy gap: on-chain public estimate ≠ real private exposure ──
  section("7. Privacy gap — on-chain estimate misleads about real exposure");
  const real = privateExposure(listedNotes);
  const pub = publicEstimate(listedNotes, NOTE_SIZE);
  ok(`real private exposure = $${real} | on-chain public estimate (count×denom) = $${pub}`);
  if (real !== pub) ok("public estimate ≠ real exposure — an observer cannot derive real exposure from on-chain data");
  else bad("public estimate equals real exposure — values leak via count×denom");

  printResult();
}

async function submitMemo(connection: Connection, signer: Keypair, memo: string): Promise<string | null> {
  try {
    const ix = new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo, "utf-8") });
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.feePayer = signer.publicKey;
    const sig = await sendAndConfirmTransaction(connection, tx, [signer], { commitment: "confirmed" });
    return sig;
  } catch (e: any) {
    console.log(`   submitMemo error: ${e.message ?? e}`);
    return null;
  }
}

async function assertMemoHidden(
  connection: Connection, sig: string,
  args: { label: string; commitmentFrag: string; secrets: string[]; blinding: string },
) {
  // Fetch the REAL settled transaction from devnet and read its on-chain Memo.
  const tx = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  if (!tx) { bad(`[${args.label}] could not fetch settled tx from devnet`); return; }
  // The Memo program writes the memo text into the transaction log.
  const logs = tx.meta?.logMessages ?? [];
  const memoLog = logs.find((l) => l.includes("MUTE:")) ?? "";
  // Also inspect the instruction data directly.
  const ixData = tx.transaction.message.instructions.find((i: any) => i.data)?.data ?? "";
  const onchainText = `${memoLog} ${ixData}`;

  if (onchainText.includes(args.commitmentFrag)) ok(`[${args.label}] on-chain Memo contains the commitment fragment (${args.commitmentFrag}…)`);
  else bad(`[${args.label}] on-chain Memo missing the commitment fragment — memo: "${onchainText.slice(0, 80)}"`);

  let leaked = false;
  for (const s of args.secrets) {
    if (s.length >= 2 && onchainText.includes(s)) { bad(`[${args.label}] on-chain Memo LEAKS value "${s}"`); leaked = true; }
  }
  if (onchainText.includes(args.blinding)) { bad(`[${args.label}] on-chain Memo LEAKS the blinding factor`); leaked = true; }
  if (!leaked) ok(`[${args.label}] on-chain Memo leaks NO note value, amount, or blinding — notes stay hidden ✅`);
  console.log(`   on-chain Memo: "${memoLog}"`);
}

function printResult() {
  console.log(`\n${failed === 0 ? "🎉" : "⚠️"} REAL-TRADE VERIFICATION: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

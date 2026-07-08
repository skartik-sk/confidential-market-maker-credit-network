/**
 * REAL USDC PAYMENT VERIFICATION — proves the buy flow moves REAL token value
 * on devnet (buyer → seller) plus the commitment memo.
 *
 * The exchange code uses the canonical devnet USDC mint (4zMMC9srt5…) via
 * lib/usdc.ts, but that mint has NO programmatic faucet. So here we create a
 * fresh 6-decimal SPL token on devnet (same decimals/behaviour as USDC), fund
 * the buyer, and run the EXACT payment logic from payAndSettleBuy:
 *   balance check → create seller ATA if missing → SPL transfer → commitment memo
 *
 * Run (dev server up on :3000):
 *   bun run apps/localnet/src/verify-real-usdc-payment.ts
 */
import {
  Connection, Keypair, PublicKey, Transaction, TransactionInstruction,
  sendAndConfirmTransaction, LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  createMint, getOrCreateAssociatedTokenAccount, mintTo, getAccount,
  createAssociatedTokenAccountInstruction, createTransferInstruction,
  getAssociatedTokenAddressSync, TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { usdcToRaw } from "../../web-next/src/lib/usdc";
import { mintNotes } from "../../web-next/src/lib/note-vault";

const API = "http://localhost:3000";
const RPC = "https://api.devnet.solana.com";
const MEMO_PROGRAM = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ✅ ${m}`); };
const bad = (m: string) => { failed++; console.log(`  ❌ ${m}`); };
const section = (t: string) => console.log(`\n── ${t} ──────────────────────────`);

function loadKeypair(p: string) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(p, "utf8"))));
}

async function main() {
  const connection = new Connection(RPC, {
    commitment: "confirmed",
    fetch: (url, options) => {
      const headers = new Headers(options?.headers);
      headers.set("content-type", "application/json");
      return fetch(url, { ...options, headers });
    },
  });
  const buyer = loadKeypair(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config", "solana", "id.json"));
  const seller = Keypair.generate();
  console.log("\n🧪 REAL USDC PAYMENT VERIFICATION (devnet)\n");
  console.log(`   buyer : ${buyer.publicKey.toBase58().slice(0, 12)}…  (${(await connection.getBalance(buyer.publicKey)) / LAMPORTS_PER_SOL} SOL)`);
  console.log(`   seller: ${seller.publicKey.toBase58().slice(0, 12)}…`);

  // 1. Create a 6-decimal test mint (= USDC behaviour) on devnet.
  section("1. Create a 6-decimal SPL token on devnet (USDC-equivalent)");
  const mint = await createMint(connection, buyer, buyer.publicKey, null, 6);
  ok(`mint created: ${mint.toBase58().slice(0, 12)}… (6 decimals, buyer = mint authority)`);

  // 2. Fund the buyer with a large balance (so we can pay a big ask).
  const buyerAta = (await getOrCreateAssociatedTokenAccount(connection, buyer, mint, buyer.publicKey)).address;
  const FUND = 100_000 * 1e6; // 100,000 "USDC"
  await mintTo(connection, buyer, mint, buyerAta, buyer, FUND);
  ok(`funded buyer with ${FUND / 1e6} USDC-equivalent`);

  // 3. Drive the REAL REST API: list notes as the seller, then we (buyer) buy them.
  section("2. SELL (REST) — list notes for the seller");
  const MARKET = "SOL-14D", NOTE_SIZE = 1000, NOTE_COUNT = 5;
  const askPriceUsd = Math.round(NOTE_COUNT * NOTE_SIZE * 0.97); // 4850
  const listRes = await fetch(`${API}/api/exchange/listings`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      seller: seller.publicKey.toBase58(),
      noteCount: NOTE_COUNT, noteSizeUsd: NOTE_SIZE, askPriceUsd,
      daysToMaturity: 14, privacy: "Umbra+Arcium",
      creditLineId: seller.publicKey.toBase58().slice(0, 6) + "…" + seller.publicKey.toBase58().slice(-4),
      market: MARKET,
    }),
  });
  const listing = (await listRes.json()).listing;
  if (!listRes.ok || !listing) { bad(`list failed: ${JSON.stringify(await listRes.json())}`); return finish(); }
  ok(`listed ${listing.id} — ask $${askPriceUsd}`);

  // 4. BUY (REST) — fill the listing.
  section("3. BUY (REST) — fill the listing");
  const buyRes = await fetch(`${API}/api/exchange/buy`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ listingId: listing.id, buyer: buyer.publicKey.toBase58(), settlementId: "settle_verify_usdc_001" }),
  });
  const trade = (await buyRes.json()).trade;
  if (!buyRes.ok || !trade) { bad(`buy failed: ${JSON.stringify(await buyRes.json())}`); return finish(); }
  ok(`filled ${trade.id}`);

  // 5. The REAL payment — replicate payAndSettleBuy exactly, on devnet.
  section("4. REAL PAYMENT — buyer pays seller USDC on devnet (ATA + transfer + memo)");
  const sellerAta = getAssociatedTokenAddressSync(mint, seller.publicKey, false, TOKEN_PROGRAM_ID);
  const ixs: TransactionInstruction[] = [];
  if (!(await connection.getAccountInfo(sellerAta, "confirmed"))) {
    ixs.push(createAssociatedTokenAccountInstruction(buyer.publicKey, sellerAta, seller.publicKey, mint));
    ok("seller had no USDC ATA — adding create-ATA ix (buyer pays rent)");
  }
  const rawAmount = usdcToRaw(askPriceUsd);
  ixs.push(createTransferInstruction(buyerAta, sellerAta, buyer.publicKey, rawAmount));

  // Commitment (note values hidden) + memo, same as the app.
  const notes = mintNotes(listing.creditLineId, NOTE_SIZE, NOTE_COUNT, Date.now());
  const commitment = notes[0].commitment;
  const memo = `MUTE:buy:${MARKET}:${listing.id}:${commitment.slice(0, 16)}:settle_verif`;
  ixs.push(new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM, data: Buffer.from(memo, "utf-8") }));

  const buyerBefore = Number((await getAccount(connection, buyerAta, "confirmed")).amount) / 1e6;
  const tx = new Transaction().add(...ixs);
  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = buyer.publicKey;
  const sig = await sendAndConfirmTransaction(connection, tx, [buyer], { commitment: "confirmed" });
  ok(`payment tx landed → https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // 6. Assert REAL value moved.
  section("5. Assert REAL value moved on devnet");
  const buyerAfter = Number((await getAccount(connection, buyerAta, "confirmed")).amount) / 1e6;
  const sellerAfter = Number((await getAccount(connection, sellerAta, "confirmed")).amount) / 1e6;
  console.log(`   buyer: ${buyerBefore} → ${buyerAfter} USDC  | seller: 0 → ${sellerAfter} USDC`);
  if (Math.abs((buyerBefore - buyerAfter) - askPriceUsd) < 1e-6) ok(`buyer balance decreased by exactly $${askPriceUsd} (= ask)`);
  else bad(`buyer balance change ${(buyerBefore - buyerAfter)} ≠ ask ${askPriceUsd}`);
  if (Math.abs(sellerAfter - askPriceUsd) < 1e-6) ok(`seller received exactly $${askPriceUsd} USDC`);
  else bad(`seller balance ${sellerAfter} ≠ ask ${askPriceUsd}`);

  // 7. Assert the on-chain memo hides note values.
  section("6. On-chain memo hides note values");
  const fetched = await connection.getTransaction(sig, { maxSupportedTransactionVersion: 0, commitment: "confirmed" });
  const memoLog = (fetched?.meta?.logMessages ?? []).find((l) => l.includes("MUTE:")) ?? "";
  console.log(`   on-chain memo: "${memoLog}"`);
  if (memoLog.includes(commitment.slice(0, 16))) ok("memo contains the commitment fragment");
  else bad("memo missing the commitment fragment");
  const leaks = notes.some((n) => memoLog.includes(String(n.valueUsd))) || memoLog.includes(String(askPriceUsd));
  if (!leaks) ok("memo leaks NO note value and NO amount — notes stay hidden");
  else bad("memo leaks a value — confidentiality broken");

  finish();
}

function finish() {
  console.log(`\n${failed === 0 ? "🎉" : "⚠️"} REAL USDC PAYMENT VERIFICATION: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });

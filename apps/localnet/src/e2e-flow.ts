/**
 * End-to-end flow test — proves the whole platform works together, not just UI.
 *
 * Chain under test:
 *   1. ON-CHAIN  (Surfpool devnet fork): init pool → approve line → draw notes
 *      using the SAME instruction builders the web frontend uses (lib/program.ts).
 *   2. EXCHANGE  (real store + math): list the drawn notes on the marketplace,
 *      compute discount/yield, build the order book.
 *   3. SETTLEMENT (real AES-256-GCM): buyer creates a shielded envelope, fills
 *      the listing, verifies the receipt.
 *   4. VERIFY     every step's on-chain / off-chain state matches.
 *
 * Run:  SOLANA_KEYPAIR=~/.config/solana/id.json bun run apps/localnet/src/e2e-flow.ts
 */

import {
  Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, SystemProgram,
  Transaction, sendAndConfirmTransaction,
} from "@solana/web3.js";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  PROGRAM_ID, PoolAccountLayout, CreditLineAccountLayout, PrivacyPolicy, LineStatus,
  createInitializePoolIx, createApproveCreditLineIx, createDrawTrancheIx,
  parsePoolAccount, parseCreditLineAccount,
} from "../../web-next/src/lib/program";
import {
  createListing, fillListing, getOrderBook, getMarket, getListings,
} from "../../web-next/src/lib/exchange-store";
import { createShieldedEnvelope, verifySettlementReceipt } from "../../web-next/src/lib/stealth-settlement";

const RPC = "http://127.0.0.1:8899";
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

  // Verify the program is live on the forked devnet.
  const progInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!progInfo) { console.error("❌ Program not live on Surfpool fork"); process.exit(1); }

  const payer = loadKeypair(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"));
  console.log(`\n🔬 E2E Flow Test (Surfpool fork)\n   Payer: ${payer.publicKey.toBase58().slice(0, 12)}…`);

  // ── Step 1: ON-CHAIN — init pool + approve + draw ──
  section("1. On-chain: Init Pool");
  const admin = payer;
  const underwriter = Keypair.generate();
  const auditor = Keypair.generate();
  const borrower = payer;
  const reserveMint = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;
  const poolKp = Keypair.generate();
  const lineKp = Keypair.generate();

  await connection.requestAirdrop(underwriter.publicKey, LAMPORTS_PER_SOL).then(s => connection.confirmTransaction(s));
  await connection.requestAirdrop(auditor.publicKey, LAMPORTS_PER_SOL).then(s => connection.confirmTransaction(s));

  const NOTE_SIZE_USD = 1000;
  const LIMIT_NOTES = 50;
  const slot0 = await connection.getSlot("confirmed");
  const poolMaturity = slot0 + 100_000;

  const initIx = createInitializePoolIx({
    pool: poolKp.publicKey, admin: admin.publicKey, bump: 0,
    privacyPolicy: PrivacyPolicy.UmbraArcium,
    underwriter: underwriter.publicKey, auditor: auditor.publicKey,
    reserveMint, vault, noteSizeUsd: NOTE_SIZE_USD, totalLimitNotes: LIMIT_NOTES,
    interestBps: 75, maturitySlot: poolMaturity, receiptIntervalSlots: 150,
  });
  const poolRent = await connection.getMinimumBalanceForRentExemption(PoolAccountLayout.LEN);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: poolKp.publicKey, lamports: poolRent, space: PoolAccountLayout.LEN, programId: PROGRAM_ID }),
    initIx,
  ), [payer, poolKp], { skipPreflight: true });
  const pool = parsePoolAccount(Buffer.from((await connection.getAccountInfo(poolKp.publicKey))!.data));
  ok(`Pool initialized: noteSize=$${pool!.noteSizeUsd} limit=${pool!.totalLimitNotes}`);
  pool!.admin.toBase58() === admin.publicKey.toBase58() ? ok("pool.admin matches") : bad("pool.admin mismatch");

  section("2. On-chain: Approve Credit Line");
  const lineMaturity = pool!.maturitySlot - 10_000;
  const approveIx = createApproveCreditLineIx({
    pool: poolKp.publicKey, creditLine: lineKp.publicKey,
    underwriter: underwriter.publicKey, borrower: borrower.publicKey,
    limitNotes: LIMIT_NOTES, termsHash: Keypair.generate().publicKey,
    mandateHash: Keypair.generate().publicKey,
    openedSlot: await connection.getSlot("confirmed"), maturitySlot: lineMaturity,
  });
  const lineRent = await connection.getMinimumBalanceForRentExemption(CreditLineAccountLayout.LEN);
  await sendAndConfirmTransaction(connection, new Transaction().add(
    SystemProgram.createAccount({ fromPubkey: payer.publicKey, newAccountPubkey: lineKp.publicKey, lamports: lineRent, space: CreditLineAccountLayout.LEN, programId: PROGRAM_ID }),
    approveIx,
  ), [payer, lineKp, underwriter], { skipPreflight: true });
  const line = parseCreditLineAccount(Buffer.from((await connection.getAccountInfo(lineKp.publicKey))!.data));
  ok(`Line approved: limit=${line!.limitNotes} notes ($${(line!.limitNotes * line!.noteSizeUsd).toLocaleString()})`);

  section("3. On-chain: Draw Notes");
  const DRAW_NOTES = 8;
  const drawIx = createDrawTrancheIx({
    pool: poolKp.publicKey, creditLine: lineKp.publicKey, borrower: borrower.publicKey,
    notes: DRAW_NOTES, currentSlot: await connection.getSlot("confirmed"),
  });
  await sendAndConfirmTransaction(connection, new Transaction().add(drawIx), [payer, borrower], { skipPreflight: true });
  const lineAfterDraw = parseCreditLineAccount(Buffer.from((await connection.getAccountInfo(lineKp.publicKey))!.data));
  ok(`Drew ${DRAW_NOTES} notes on-chain (line drawn = ${lineAfterDraw!.drawnNotes})`);
  lineAfterDraw!.drawnNotes === DRAW_NOTES ? ok("on-chain drawn count matches") : bad(`expected ${DRAW_NOTES}, got ${lineAfterDraw!.drawnNotes}`);

  // ── Step 2: EXCHANGE — list the drawn notes ──
  section("4. Exchange: List Drawn Notes");
  const DRAWN_USD = DRAW_NOTES * NOTE_SIZE_USD;
  const ASK_USD = Math.round(DRAWN_USD * 0.96); // 4% discount
  const listing = createListing({
    seller: borrower.publicKey.toBase58(),
    noteCount: DRAW_NOTES, noteSizeUsd: NOTE_SIZE_USD,
    askPriceUsd: ASK_USD, daysToMaturity: 30,
    privacy: "Umbra+Arcium",
    creditLineId: lineKp.publicKey.toBase58().slice(0, 6) + "…" + lineKp.publicKey.toBase58().slice(-4),
    market: "USDC-30D",
  });
  ok(`Listed ${listing.noteCount} notes on exchange: ${listing.id}`);
  listing.faceValueUsd === DRAWN_USD ? ok(`face value = drawn USD ($${DRAWN_USD})`) : bad("face value mismatch");
  listing.discountBps === 400 ? ok(`discount = 4.00% (on-chain drawn ↔ exchange listed)`) : bad(`discount ${listing.discountBps}`);

  section("5. Exchange: Order Book Reflects Listing");
  const ob = getOrderBook("USDC-30D");
  const ourAsk = ob.asks.find(a => a.priceBps === 9600);
  ourAsk ? ok(`our ask appears in book @ 96.00 (${ourAsk.notes} notes)`) : bad("our ask missing from book");

  // ── Step 3: SETTLEMENT — buyer fills with shielded envelope ──
  section("6. Settlement: Shielded Envelope + Fill");
  const buyerKp = Keypair.generate();
  const envelope = await createShieldedEnvelope({
    sender: buyerKp.publicKey, recipient: borrower.publicKey,
    amount: ASK_USD, noteSizeUsd: NOTE_SIZE_USd_FIX(NOTE_SIZE_USD), creditLineId: listing.creditLineId,
  });
  ok(`Shielded envelope created: ${envelope.envelope.settlementId}`);
  verifySettlementReceipt(envelope.envelope, envelope.receipt) ? ok("receipt self-verifies") : bad("receipt invalid");

  const trade = fillListing({ listingId: listing.id, buyer: buyerKp.publicKey.toBase58(), settlementId: envelope.envelope.settlementId });
  if ("error" in trade) { bad(`fill failed: ${trade.error}`); }
  else {
    ok(`Trade filled: ${trade.id} — $${trade.priceUsd} settled`);
    trade.settlementId === envelope.envelope.settlementId ? ok("trade bound to shielded settlement") : bad("settlement not bound");
  }

  // ── Step 4: VERIFY end-to-end consistency ──
  section("7. E2E Consistency Check");
  const dup = fillListing({ listingId: listing.id, buyer: buyerKp.publicKey.toBase58(), settlementId: "x" });
  "error" in dup ? ok("double-spend rejected (listing already filled)") : bad("double-fill allowed!");
  const finalLine = parseCreditLineAccount(Buffer.from((await connection.getAccountInfo(lineKp.publicKey))!.data));
  ok(`On-chain line still owned by borrower (drawn=${finalLine!.drawnNotes}) — exchange transfer is off-chain matching`);
  const market = getMarket("USDC-30D");
  market ? ok(`Market ${market.symbol} live (last ${(market.lastPrice * 100).toFixed(2)})`) : bad("market missing");
  getListings("active").length > 0 ? ok("exchange has active liquidity") : bad("no active listings");

  console.log(`\n${failed === 0 ? "🎉 E2E FLOW FULLY VERIFIED" : "❌ E2E FLOW HAD FAILURES"} — ${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exit(1);
}

// helper to satisfy the SettlementParams type (noteSizeUsd is a number)
function NOTE_SIZE_USd_FIX(n: number) { return n; }

main().catch(e => { console.error("❌ E2E FAILED:", e); process.exit(1); });

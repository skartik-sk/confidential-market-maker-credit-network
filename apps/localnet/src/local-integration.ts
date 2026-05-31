/**
 * Integration test against local Solana validator (http://127.0.0.1:8899).
 *
 * Tests the SAME instruction builders used by the web frontend (program.ts)
 * with real on-chain transactions. This catches account-ordering bugs that
 * unit tests cannot.
 *
 * Prerequisites:
 *   1. `solana-test-validator` running at 127.0.0.1:8899
 *   2. Program deployed: `solana program deploy programs/credit-vault/target/deploy/confidential_credit_vault.so --url http://127.0.0.1:8899`
 *
 * Run:  bun run apps/localnet/src/local-integration.ts
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";

// Import the ACTUAL instruction builders from the web frontend
import {
  PROGRAM_ID,
  PoolAccountLayout,
  CreditLineAccountLayout,
  PrivacyPolicy,
  LineStatus,
  PoolStatus,
  createInitializePoolIx,
  createApproveCreditLineIx,
  createDrawTrancheIx,
  createRepayTrancheIx,
  createSettleMaturityIx,
  createPauseLineIx,
  parsePoolAccount,
  parseCreditLineAccount,
  POOL_DISCRIMINATOR,
  LINE_DISCRIMINATOR,
} from "../../web-next/src/lib/program";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOCAL_RPC = "http://127.0.0.1:8899";
const POOL_LEN = PoolAccountLayout.LEN;
const LINE_LEN = CreditLineAccountLayout.LEN;
const RECEIPT_LEN = 154;

function log(msg: string) {
  console.log(`  ${msg}`);
}

function ok(label: string) {
  console.log(`  ✅ ${label}`);
}

function section(title: string) {
  console.log(`\n${"═".repeat(60)}`);
  console.log(`  ${title}`);
  console.log(`${"═".repeat(60)}`);
}

async function getAccountData(connection: Connection, pubkey: PublicKey): Promise<Buffer | null> {
  const info = await connection.getAccountInfo(pubkey, "confirmed");
  return info ? Buffer.from(info.data) : null;
}

// PostReceipt is not in program.ts yet, so we build it inline
function createPostReceiptIx(params: {
  creditLine: PublicKey;
  receipt: PublicKey;
  auditor: PublicKey;
  periodStartSlot: number;
  periodEndSlot: number;
  acceptedSlot: number;
  receiptHash: PublicKey;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 8 + 8 + 8 + 32);
  let offset = 0;
  data.writeUInt8(4, offset); offset += 1; // tag
  // u64 LE writes
  for (let i = 0; i < 8; i++) data[offset + i] = Number((BigInt(params.periodStartSlot) >> BigInt(i * 8)) & BigInt(0xFF));
  offset += 8;
  for (let i = 0; i < 8; i++) data[offset + i] = Number((BigInt(params.periodEndSlot) >> BigInt(i * 8)) & BigInt(0xFF));
  offset += 8;
  for (let i = 0; i < 8; i++) data[offset + i] = Number((BigInt(params.acceptedSlot) >> BigInt(i * 8)) & BigInt(0xFF));
  offset += 8;
  data.set(params.receiptHash.toBuffer(), offset); offset += 32;

  return new TransactionInstruction({
    keys: [
      { pubkey: params.auditor, isSigner: true, isWritable: false },
      { pubkey: params.creditLine, isSigner: false, isWritable: true },
      { pubkey: params.receipt, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data,
  });
}

// ---------------------------------------------------------------------------
// Main test
// ---------------------------------------------------------------------------

async function main() {
  console.log("\n🔬 Credit Vault — Local Integration Test");
  console.log(`   RPC: ${LOCAL_RPC}`);
  console.log(`   Program: ${PROGRAM_ID.toBase58()}`);

  const connection = new Connection(LOCAL_RPC, {
    commitment: "confirmed",
    fetch: (url, options) => {
      const headers = new Headers(options?.headers);
      headers.set("content-type", "application/json");
      return fetch(url, { ...options, headers });
    },
  });

  // Verify program is deployed
  const programInfo = await connection.getAccountInfo(PROGRAM_ID);
  if (!programInfo) {
    console.error("❌ Program not deployed! Run:");
    console.error("   solana program deploy programs/credit-vault/target/deploy/confidential_credit_vault.so --url http://127.0.0.1:8899");
    process.exit(1);
  }
  ok("Program deployed on local validator");

  // Fund keypairs
  const payer = Keypair.generate();
  const admin = payer; // admin = payer for simplicity
  const underwriter = Keypair.generate();
  const auditor = Keypair.generate();
  const borrower = Keypair.generate();
  const reserveMint = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;

  console.log(`   Admin/Payer: ${payer.publicKey.toBase58().slice(0, 12)}...`);
  log("Airdropping SOL...");
  for (const kp of [payer, underwriter, auditor, borrower]) {
    const sig = await connection.requestAirdrop(kp.publicKey, 5 * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }
  ok("All keypairs funded");

  const poolRent = await connection.getMinimumBalanceForRentExemption(POOL_LEN);
  const lineRent = await connection.getMinimumBalanceForRentExemption(LINE_LEN);
  const receiptRent = await connection.getMinimumBalanceForRentExemption(RECEIPT_LEN);

  // Account keypairs
  const poolKp = Keypair.generate();
  const lineKp = Keypair.generate();
  const receiptKp = Keypair.generate();

  // =======================================================================
  // TEST 1: Initialize Pool (using program.ts createInitializePoolIx)
  // =======================================================================
  section("Test 1: InitializePool");

  const currentSlot = await connection.getSlot("confirmed");
  const maturitySlot = currentSlot + 50_000;

  const initIx = createInitializePoolIx({
    pool: poolKp.publicKey,
    admin: admin.publicKey,
    bump: 251,
    privacyPolicy: PrivacyPolicy.UmbraArcium,
    underwriter: underwriter.publicKey,
    auditor: auditor.publicKey,
    reserveMint,
    vault,
    noteSizeUsd: 1_000,
    totalLimitNotes: 100,
    interestBps: 75,
    maturitySlot,
    receiptIntervalSlots: 150,
  });

  const initSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: poolKp.publicKey,
        lamports: poolRent,
        space: POOL_LEN,
        programId: PROGRAM_ID,
      }),
      initIx,
    ),
    [payer, poolKp],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`InitializePool tx: ${initSig.slice(0, 20)}...`);

  // Verify pool state
  const poolData = await getAccountData(connection, poolKp.publicKey);
  if (!poolData) throw new Error("Pool account not found after init");
  const pool = parsePoolAccount(poolData);
  if (!pool) throw new Error("Failed to parse pool account (bad discriminator or uninitialized)");
  if (pool.admin.toBase58() !== admin.publicKey.toBase58()) throw new Error(`Bad admin: ${pool.admin.toBase58()}`);
  if (pool.status !== PoolStatus.Active) throw new Error(`Bad status: ${pool.status}`);
  if (pool.noteSizeUsd !== 1_000) throw new Error(`Bad noteSizeUsd: ${pool.noteSizeUsd}`);
  if (pool.totalLimitNotes !== 100) throw new Error(`Bad totalLimitNotes: ${pool.totalLimitNotes}`);
  if (pool.interestBps !== 75) throw new Error(`Bad interestBps: ${pool.interestBps}`);
  ok(`Pool verified: status=${pool.status} noteSize=$${pool.noteSizeUsd} limit=${pool.totalLimitNotes}`);

  // =======================================================================
  // TEST 2: Approve Credit Line (using program.ts createApproveCreditLineIx)
  // Uses pool's on-chain maturity slot — same fix as the web UI
  // =======================================================================
  section("Test 2: ApproveCreditLine (line maturity < pool maturity)");

  // Read pool maturity from on-chain (same pattern as the fixed UI)
  const freshPoolData = await getAccountData(connection, poolKp.publicKey);
  const freshPool = parsePoolAccount(freshPoolData!);
  const lineMaturity = freshPool!.maturitySlot - 5_000; // must be < pool maturity

  const approveIx = createApproveCreditLineIx({
    pool: poolKp.publicKey,
    creditLine: lineKp.publicKey,
    underwriter: underwriter.publicKey,
    borrower: borrower.publicKey,
    limitNotes: 30,
    termsHash: Keypair.generate().publicKey,
    mandateHash: Keypair.generate().publicKey,
    openedSlot: await connection.getSlot("confirmed"), // current slot (may differ from pool creation slot)
    maturitySlot: lineMaturity, // derived from pool's on-chain maturity
  });

  const approveSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: lineKp.publicKey,
        lamports: lineRent,
        space: LINE_LEN,
        programId: PROGRAM_ID,
      }),
      approveIx,
    ),
    [payer, lineKp, underwriter],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`ApproveCreditLine tx: ${approveSig.slice(0, 20)}...`);

  // Verify line state
  const lineDataRaw = await getAccountData(connection, lineKp.publicKey);
  if (!lineDataRaw) throw new Error("Line account not found after approve");
  const line = parseCreditLineAccount(lineDataRaw);
  if (!line) throw new Error("Failed to parse credit line account");
  if (line.status !== LineStatus.Active) throw new Error(`Bad status: ${line.status}`);
  if (line.borrower.toBase58() !== borrower.publicKey.toBase58()) throw new Error("Bad borrower");
  if (line.limitNotes !== 30) throw new Error(`Bad limitNotes: ${line.limitNotes}`);
  ok(`Line verified: status=${line.status} borrower=${line.borrower.toBase58().slice(0, 8)}... limit=${line.limitNotes}`);

  // =======================================================================
  // TEST 3: Draw Tranche (using program.ts createDrawTrancheIx)
  // =======================================================================
  section("Test 3: DrawTranche (6 notes)");

  const drawSlot = await connection.getSlot("confirmed");
  const drawIx = createDrawTrancheIx({
    pool: poolKp.publicKey,
    creditLine: lineKp.publicKey,
    borrower: borrower.publicKey,
    notes: 6,
    currentSlot: drawSlot,
  });

  const drawSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(drawIx),
    [payer, borrower],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`DrawTranche tx: ${drawSig.slice(0, 20)}...`);

  // Verify state after draw
  const poolAfterDraw = parsePoolAccount((await getAccountData(connection, poolKp.publicKey))!);
  const lineAfterDraw = parseCreditLineAccount((await getAccountData(connection, lineKp.publicKey))!);
  if (poolAfterDraw!.totalDrawnNotes !== 6) throw new Error(`Pool drawn mismatch: ${poolAfterDraw!.totalDrawnNotes}`);
  if (poolAfterDraw!.outstandingNotes !== 6) throw new Error(`Pool outstanding mismatch: ${poolAfterDraw!.outstandingNotes}`);
  if (lineAfterDraw!.drawnNotes !== 6) throw new Error(`Line drawn mismatch: ${lineAfterDraw!.drawnNotes}`);
  ok(`Pool: drawn=6 outstanding=6 | Line: drawn=6`);

  // =======================================================================
  // TEST 4: Repay Tranche (using program.ts createRepayTrancheIx)
  // =======================================================================
  section("Test 4: RepayTranche (2 notes)");

  const repaySlot = await connection.getSlot("confirmed");
  const repayIx = createRepayTrancheIx({
    pool: poolKp.publicKey,
    creditLine: lineKp.publicKey,
    borrower: borrower.publicKey,
    notes: 2,
    currentSlot: repaySlot,
  });

  const repaySig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(repayIx),
    [payer, borrower],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`RepayTranche tx: ${repaySig.slice(0, 20)}...`);

  const poolAfterRepay = parsePoolAccount((await getAccountData(connection, poolKp.publicKey))!);
  const lineAfterRepay = parseCreditLineAccount((await getAccountData(connection, lineKp.publicKey))!);
  if (poolAfterRepay!.totalRepaidNotes !== 2) throw new Error(`Pool repaid mismatch: ${poolAfterRepay!.totalRepaidNotes}`);
  if (poolAfterRepay!.outstandingNotes !== 4) throw new Error(`Pool outstanding mismatch: ${poolAfterRepay!.outstandingNotes}`);
  if (lineAfterRepay!.repaidNotes !== 2) throw new Error(`Line repaid mismatch: ${lineAfterRepay!.repaidNotes}`);
  ok(`Pool: drawn=6 repaid=2 outstanding=4 | Line: drawn=6 repaid=2`);

  // =======================================================================
  // TEST 5: Post Receipt (inline builder since program.ts doesn't export it)
  // =======================================================================
  section("Test 5: PostReceipt");

  const receiptIx = createPostReceiptIx({
    creditLine: lineKp.publicKey,
    receipt: receiptKp.publicKey,
    auditor: auditor.publicKey,
    periodStartSlot: drawSlot,
    periodEndSlot: drawSlot + 100,
    acceptedSlot: drawSlot + 101,
    receiptHash: Keypair.generate().publicKey,
  });

  const receiptSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: receiptKp.publicKey,
        lamports: receiptRent,
        space: RECEIPT_LEN,
        programId: PROGRAM_ID,
      }),
      receiptIx,
    ),
    [payer, receiptKp, auditor],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`PostReceipt tx: ${receiptSig.slice(0, 20)}...`);

  // =======================================================================
  // TEST 6: Pause Line (using program.ts createPauseLineIx)
  // =======================================================================
  section("Test 6: PauseLine");

  const pauseIx = createPauseLineIx({
    creditLine: lineKp.publicKey,
    underwriter: underwriter.publicKey,
    targetStatus: LineStatus.Paused,
  });

  const pauseSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(pauseIx),
    [payer, underwriter],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`PauseLine tx: ${pauseSig.slice(0, 20)}...`);

  const lineAfterPause = parseCreditLineAccount((await getAccountData(connection, lineKp.publicKey))!);
  if (lineAfterPause!.status !== LineStatus.Paused) throw new Error(`Line not paused: ${lineAfterPause!.status}`);
  ok(`Line status: ${lineAfterPause!.status} (Paused)`);

  // Verify draw fails while paused
  section("Test 6b: Draw while paused (should fail)");
  const drawPausedIx = createDrawTrancheIx({
    pool: poolKp.publicKey,
    creditLine: lineKp.publicKey,
    borrower: borrower.publicKey,
    notes: 1,
    currentSlot: await connection.getSlot("confirmed"),
  });
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(drawPausedIx),
      [payer, borrower],
      { skipPreflight: true, commitment: "confirmed" },
    );
    throw new Error("Draw should have failed while paused!");
  } catch (e: any) {
    if (e.message.includes("should have failed")) throw e;
    ok(`Draw correctly rejected while paused`);
  }

  // Reactivate line
  section("Test 6c: Reactivate Line");
  const reactivateIx = createPauseLineIx({
    creditLine: lineKp.publicKey,
    underwriter: underwriter.publicKey,
    targetStatus: LineStatus.Active,
  });
  const reactivateSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(reactivateIx),
    [payer, underwriter],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`Reactivate tx: ${reactivateSig.slice(0, 20)}...`);
  const lineAfterReactivate = parseCreditLineAccount((await getAccountData(connection, lineKp.publicKey))!);
  if (lineAfterReactivate!.status !== LineStatus.Active) throw new Error(`Line not active: ${lineAfterReactivate!.status}`);
  ok(`Line reactivated: status=${lineAfterReactivate!.status}`);

  // =======================================================================
  // TEST 7: Settle Maturity (using program.ts createSettleMaturityIx)
  // =======================================================================
  section("Test 7: SettleMaturity (should default 4 outstanding notes)");

  // Warp the validator past maturity using raw JSON-RPC
  const settleSlot = maturitySlot + 1;
  try {
    await fetch(LOCAL_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "setSlot", params: [settleSlot] }),
    });
  } catch {
    // setSlot not available on all validator versions — test will still work
    // if current slot > maturity (local validator advances quickly)
  }

  const settleIx = createSettleMaturityIx({
    pool: poolKp.publicKey,
    creditLine: lineKp.publicKey,
    currentSlot: settleSlot,
  });

  const settleSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(settleIx),
    [payer],
    { skipPreflight: true, commitment: "confirmed" },
  );
  ok(`SettleMaturity tx: ${settleSig.slice(0, 20)}...`);

  const poolAfterSettle = parsePoolAccount((await getAccountData(connection, poolKp.publicKey))!);
  const lineAfterSettle = parseCreditLineAccount((await getAccountData(connection, lineKp.publicKey))!);
  ok(`Pool: drawn=${poolAfterSettle!.totalDrawnNotes} repaid=${poolAfterSettle!.totalRepaidNotes} defaulted=${poolAfterSettle!.totalDefaultedNotes} outstanding=${poolAfterSettle!.outstandingNotes}`);
  ok(`Line: status=${lineAfterSettle!.status} (4=Defaulted) drawn=${lineAfterSettle!.drawnNotes} repaid=${lineAfterSettle!.repaidNotes} defaulted=${lineAfterSettle!.defaultedNotes}`);

  if (poolAfterSettle!.totalDefaultedNotes !== 4) throw new Error(`Expected 4 defaulted, got ${poolAfterSettle!.totalDefaultedNotes}`);
  if (poolAfterSettle!.outstandingNotes !== 0) throw new Error(`Expected 0 outstanding, got ${poolAfterSettle!.outstandingNotes}`);
  if (lineAfterSettle!.status !== LineStatus.Defaulted) throw new Error(`Expected Defaulted, got ${lineAfterSettle!.status}`);
  if (lineAfterSettle!.defaultedNotes !== 4) throw new Error(`Expected 4 defaulted notes, got ${lineAfterSettle!.defaultedNotes}`);

  // =======================================================================
  // TEST 8: Error cases
  // =======================================================================
  section("Test 8: Error cases");

  // 8a: Re-initialize pool (should fail)
  log("8a: Re-initialize pool...");
  const reInitIx = createInitializePoolIx({
    pool: poolKp.publicKey,
    admin: admin.publicKey,
    bump: 251,
    privacyPolicy: PrivacyPolicy.UmbraArcium,
    underwriter: underwriter.publicKey,
    auditor: auditor.publicKey,
    reserveMint,
    vault,
    noteSizeUsd: 1_000,
    totalLimitNotes: 100,
    interestBps: 75,
    maturitySlot,
    receiptIntervalSlots: 150,
  });
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(reInitIx),
      [payer],
      { skipPreflight: true, commitment: "confirmed" },
    );
    throw new Error("Re-init should have failed!");
  } catch (e: any) {
    if (e.message.includes("should have failed")) throw e;
    ok("Re-init pool correctly rejected (AccountAlreadyInitialized)");
  }

  // 8b: Overdraw (should fail)
  log("8b: Overdraw...");
  // Create a fresh line for this test
  const overLineKp = Keypair.generate();
  const overApproveIx = createApproveCreditLineIx({
    pool: poolKp.publicKey,
    creditLine: overLineKp.publicKey,
    underwriter: underwriter.publicKey,
    borrower: borrower.publicKey,
    limitNotes: 5,
    termsHash: Keypair.generate().publicKey,
    mandateHash: Keypair.generate().publicKey,
    openedSlot: await connection.getSlot("confirmed"),
    maturitySlot: maturitySlot - 5_000,
  });
  await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: overLineKp.publicKey,
        lamports: lineRent,
        space: LINE_LEN,
        programId: PROGRAM_ID,
      }),
      overApproveIx,
    ),
    [payer, overLineKp, underwriter],
    { skipPreflight: true, commitment: "confirmed" },
  );

  const overDrawIx = createDrawTrancheIx({
    pool: poolKp.publicKey,
    creditLine: overLineKp.publicKey,
    borrower: borrower.publicKey,
    notes: 6, // exceeds limit of 5
    currentSlot: await connection.getSlot("confirmed"),
  });
  try {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(overDrawIx),
      [payer, borrower],
      { skipPreflight: true, commitment: "confirmed" },
    );
    throw new Error("Overdraw should have failed!");
  } catch (e: any) {
    if (e.message.includes("should have failed")) throw e;
    ok("Overdraw correctly rejected (InsufficientFunds)");
  }

  // =======================================================================
  // FINAL SUMMARY
  // =======================================================================
  section("🎉 ALL TESTS PASSED");
  console.log("\n  Final on-chain state:");
  console.log(`    Pool:   ${poolKp.publicKey.toBase58()}`);
  console.log(`    Line:   ${lineKp.publicKey.toBase58()}`);
  console.log(`    Drawn: 6 | Repaid: 2 | Defaulted: 4`);
  console.log(`    Total: 6 drawn, 2 repaid, 4 defaulted, 0 outstanding\n`);

  console.log("  Transaction signatures:");
  console.log(`    Init:     ${initSig}`);
  console.log(`    Approve:  ${approveSig}`);
  console.log(`    Draw:     ${drawSig}`);
  console.log(`    Repay:    ${repaySig}`);
  console.log(`    Receipt:  ${receiptSig}`);
  console.log(`    Pause:    ${pauseSig}`);
  console.log(`    Settle:   ${settleSig}\n`);
}

main().catch((error) => {
  console.error("\n❌ TEST FAILED:", error.message);
  if (error.logs) {
    console.error("\nProgram logs:");
    error.logs.forEach((l: string) => console.error(`  ${l}`));
  }
  process.exit(1);
});

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

const RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey("G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5");
const POOL_LEN = 279;
const LINE_LEN = 278;
const RECEIPT_LEN = 154;

function explorerTx(sig: string) {
  return `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
}
function explorerAddr(addr: string) {
  return `https://explorer.solana.com/address/${addr}?cluster=devnet`;
}

async function main() {
  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    fetch: (url, options) => {
      const headers = new Headers(options?.headers);
      headers.set("content-type", "application/json");
      return fetch(url, { ...options, headers });
    },
  });

  const payer = loadKeypair(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"));
  const pool = Keypair.generate();
  const line = Keypair.generate();
  const receipt = Keypair.generate();
  const borrower = Keypair.generate();
  const underwriter = Keypair.generate();
  const auditor = Keypair.generate();
  const reserveMint = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;

  console.log(`\n🏦 Devnet Credit Vault Smoke Test`);
  console.log(`Program: ${PROGRAM_ID.toBase58()}`);
  console.log(`Payer: ${payer.publicKey.toBase58()}\n`);

  // Airdrop SOL
  for (const kp of [payer, borrower, underwriter, auditor]) {
    const balance = await connection.getBalance(kp.publicKey);
    if (balance < LAMPORTS_PER_SOL) {
      console.log(`Airdropping SOL to ${kp.publicKey.toBase58().slice(0, 8)}...`);
      const sig = await connection.requestAirdrop(kp.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
    }
  }

  const poolRent = await connection.getMinimumBalanceForRentExemption(POOL_LEN);
  const lineRent = await connection.getMinimumBalanceForRentExemption(LINE_LEN);
  const receiptRent = await connection.getMinimumBalanceForRentExemption(RECEIPT_LEN);

  // 1. Initialize Pool
  const initSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: pool.publicKey,
        lamports: poolRent,
        space: POOL_LEN,
        programId: PROGRAM_ID,
      }),
      ix(0, initPoolData(underwriter.publicKey, auditor.publicKey, reserveMint, vault), [
        signer(payer.publicKey),
        writable(pool.publicKey),
      ]),
    ),
    [payer, pool],
    { skipPreflight: true, commitment: "confirmed" },
  );
  console.log(`✅ InitializePool: ${explorerTx(initSig)}`);
  console.log(`   Pool account: ${explorerAddr(pool.publicKey.toBase58())}`);

  // 2. Approve Credit Line
  const approveSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: line.publicKey,
        lamports: lineRent,
        space: LINE_LEN,
        programId: PROGRAM_ID,
      }),
      ix(1, approveLineData(borrower.publicKey), [
        signer(underwriter.publicKey),
        writable(pool.publicKey),
        writable(line.publicKey),
      ]),
    ),
    [payer, line, underwriter],
    { skipPreflight: true, commitment: "confirmed" },
  );
  console.log(`✅ ApproveCreditLine: ${explorerTx(approveSig)}`);

  // 3. Draw Tranche
  const drawSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ix(2, drawData(6, 20_100), [
        signer(borrower.publicKey),
        writable(pool.publicKey),
        writable(line.publicKey),
      ]),
    ),
    [payer, borrower],
    { skipPreflight: true, commitment: "confirmed" },
  );
  console.log(`✅ DrawTranche (6 notes): ${explorerTx(drawSig)}`);

  // 4. Repay Tranche
  const repaySig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ix(3, repayData(2, 20_500), [
        signer(borrower.publicKey),
        writable(pool.publicKey),
        writable(line.publicKey),
      ]),
    ),
    [payer, borrower],
    { skipPreflight: true, commitment: "confirmed" },
  );
  console.log(`✅ RepayTranche (2 notes): ${explorerTx(repaySig)}`);

  // 5. Post Receipt
  const receiptSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: receipt.publicKey,
        lamports: receiptRent,
        space: RECEIPT_LEN,
        programId: PROGRAM_ID,
      }),
      ix(4, receiptData(), [
        signer(auditor.publicKey),
        writable(line.publicKey),
        writable(receipt.publicKey),
      ]),
    ),
    [payer, receipt, auditor],
    { skipPreflight: true, commitment: "confirmed" },
  );
  console.log(`✅ PostReceipt: ${explorerTx(receiptSig)}`);

  // 6. Settle Maturity
  const settleSig = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ix(5, settleData(45_001), [writable(pool.publicKey), writable(line.publicKey)]),
    ),
    [payer],
    { skipPreflight: true, commitment: "confirmed" },
  );
  console.log(`✅ SettleMaturity: ${explorerTx(settleSig)}`);

  // Verify final state
  const poolAccount = await getAccountData(connection, pool.publicKey);
  const lineAccount = await getAccountData(connection, line.publicKey);
  const poolDrawn = poolAccount.readUInt32LE(216);
  const poolRepaid = poolAccount.readUInt32LE(220);
  const poolDefaulted = poolAccount.readUInt32LE(224);
  const lineStatus = lineAccount.readUInt8(2);
  const lineDefaulted = lineAccount.readUInt32LE(143);

  console.log(`\n📊 Final State:`);
  console.log(`   Pool: drawn=${poolDrawn} repaid=${poolRepaid} defaulted=${poolDefaulted} outstanding=${poolAccount.readUInt32LE(212)}`);
  console.log(`   Line: status=${lineStatus} (4=Defaulted) defaulted=${lineDefaulted}`);

  if (poolDrawn !== 6 || poolRepaid !== 2 || poolDefaulted !== 4) {
    throw new Error(`Unexpected pool state: drawn=${poolDrawn} repaid=${poolRepaid} defaulted=${poolDefaulted}`);
  }
  if (lineStatus !== 4 || lineDefaulted !== 4) {
    throw new Error(`Unexpected line state: status=${lineStatus} defaulted=${lineDefaulted}`);
  }

  console.log(`\n🎉 All transactions verified on devnet!`);
  console.log(`\n🔗 Explorer Links:`);
  console.log(`   Program: ${explorerAddr(PROGRAM_ID.toBase58())}`);
  console.log(`   Pool:    ${explorerAddr(pool.publicKey.toBase58())}`);
  console.log(`   Line:    ${explorerAddr(line.publicKey.toBase58())}`);

  // Save proof
  const proof = {
    ok: true,
    cluster: "devnet",
    rpcUrl: RPC_URL,
    programId: PROGRAM_ID.toBase58(),
    accounts: {
      pool: pool.publicKey.toBase58(),
      line: line.publicKey.toBase58(),
      receipt: receipt.publicKey.toBase58(),
    },
    signatures: {
      initializePool: initSig,
      approveCreditLine: approveSig,
      drawTranche: drawSig,
      repayTranche: repaySig,
      postReceipt: receiptSig,
      settleMaturity: settleSig,
    },
    explorerLinks: {
      initializePool: explorerTx(initSig),
      approveCreditLine: explorerTx(approveSig),
      drawTranche: explorerTx(drawSig),
      repayTranche: explorerTx(repaySig),
      postReceipt: explorerTx(receiptSig),
      settleMaturity: explorerTx(settleSig),
    },
    finalState: { poolDrawn, poolRepaid, poolDefaulted, lineStatus, lineDefaulted },
  };
  console.log(`\n📄 Proof JSON:`);
  console.log(JSON.stringify(proof, null, 2));
}

function ix(data: number, instructionData: Buffer, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) {
  return new TransactionInstruction({ programId: PROGRAM_ID, data: instructionData, keys });
}

function signer(pubkey: PublicKey) {
  return { pubkey, isSigner: true, isWritable: false };
}

function writable(pubkey: PublicKey) {
  return { pubkey, isSigner: false, isWritable: true };
}

function initPoolData(underwriter: PublicKey, auditor: PublicKey, reserveMint: PublicKey, vault: PublicKey) {
  const w = new Writer(1 + 1 + 1 + 32 * 4 + 8 + 4 + 2 + 8 + 8);
  w.u8(0); // tag
  w.u8(251); // bump
  w.u8(3); // privacy_policy = UmbraArcium
  w.pubkey(underwriter);
  w.pubkey(auditor);
  w.pubkey(reserveMint);
  w.pubkey(vault);
  w.u64(1_000);
  w.u32(100);
  w.u16(75);
  w.u64(50_000);
  w.u64(150);
  return w.done();
}

function approveLineData(borrower: PublicKey) {
  const w = new Writer(1 + 32 + 4 + 32 + 32 + 8 + 8);
  w.u8(1);
  w.pubkey(borrower);
  w.u32(10);
  w.bytes(Buffer.alloc(32, 7));
  w.bytes(Buffer.alloc(32, 8));
  w.u64(20_000);
  w.u64(45_000);
  return w.done();
}

function drawData(notes: number, currentSlot: number) {
  const w = new Writer(1 + 4 + 8);
  w.u8(2);
  w.u32(notes);
  w.u64(currentSlot);
  return w.done();
}

function repayData(notes: number, currentSlot: number) {
  const w = new Writer(1 + 4 + 8);
  w.u8(3);
  w.u32(notes);
  w.u64(currentSlot);
  return w.done();
}

function receiptData() {
  const w = new Writer(1 + 8 + 8 + 8 + 32);
  w.u8(4);
  w.u64(20_100);
  w.u64(20_200);
  w.u64(20_201);
  w.bytes(Buffer.alloc(32, 9));
  return w.done();
}

function settleData(currentSlot: number) {
  const w = new Writer(1 + 8);
  w.u8(5);
  w.u64(currentSlot);
  return w.done();
}

async function getAccountData(connection: Connection, pubkey: PublicKey) {
  const account = await connection.getAccountInfo(pubkey, "confirmed");
  if (!account) throw new Error(`Account not found: ${pubkey.toBase58()}`);
  return account.data;
}

function loadKeypair(path: string) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

class Writer {
  private readonly buffer: Buffer;
  private offset = 0;
  constructor(length: number) { this.buffer = Buffer.alloc(length); }
  u8(value: number) { this.buffer.writeUInt8(value, this.offset); this.offset += 1; }
  u16(value: number) { this.buffer.writeUInt16LE(value, this.offset); this.offset += 2; }
  u32(value: number) { this.buffer.writeUInt32LE(value, this.offset); this.offset += 4; }
  u64(value: number) { this.buffer.writeBigUInt64LE(BigInt(value), this.offset); this.offset += 8; }
  pubkey(value: PublicKey) { this.bytes(value.toBuffer()); }
  bytes(value: Buffer) { value.copy(this.buffer, this.offset); this.offset += value.length; }
  done() { return this.buffer; }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

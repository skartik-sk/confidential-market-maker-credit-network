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

const RPC_URL = process.env.SURFPOOL_RPC_URL ?? "http://127.0.0.1:8899";
const POOL_LEN = 279;
const LINE_LEN = 278;
const RECEIPT_LEN = 154;
const COMPUTE_LIMITS = {
  initializePool: 1_300,
  approveCreditLine: 1_100,
  drawTranche: 950,
  repayTranche: 950,
  postReceipt: 850,
  settleMaturity: 900,
} as const;

async function main() {
  const connection = new Connection(RPC_URL, {
    commitment: "confirmed",
    fetch: (url, options) => {
      const headers = new Headers(options?.headers);
      headers.set("content-type", "application/json");
      return fetch(url, {
        ...options,
        headers,
      });
    },
  });
  const payer = loadKeypair(process.env.SOLANA_KEYPAIR ?? join(homedir(), ".config/solana/id.json"));
  const program = loadKeypair("programs/credit-vault/target/deploy/confidential_credit_vault-keypair.json");
  const programId = program.publicKey;
  const pool = Keypair.generate();
  const line = Keypair.generate();
  const receipt = Keypair.generate();
  const borrower = Keypair.generate();
  const underwriter = Keypair.generate();
  const auditor = Keypair.generate();
  const reserveMint = Keypair.generate().publicKey;
  const vault = Keypair.generate().publicKey;

  await ensureBalance(connection, payer.publicKey);
  await ensureBalance(connection, borrower.publicKey);
  await ensureBalance(connection, underwriter.publicKey);
  await ensureBalance(connection, auditor.publicKey);

  const poolRent = await connection.getMinimumBalanceForRentExemption(POOL_LEN);
  const lineRent = await connection.getMinimumBalanceForRentExemption(LINE_LEN);
  const receiptRent = await connection.getMinimumBalanceForRentExemption(RECEIPT_LEN);

  const initSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: pool.publicKey,
        lamports: poolRent,
        space: POOL_LEN,
        programId,
      }),
      ix(programId, initPoolData(underwriter.publicKey, auditor.publicKey, reserveMint, vault), [
        signer(payer.publicKey),
        writable(pool.publicKey),
      ]),
    ),
    [payer, pool],
  );

  const approveSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: line.publicKey,
        lamports: lineRent,
        space: LINE_LEN,
        programId,
      }),
      ix(programId, approveLineData(borrower.publicKey), [
        signer(underwriter.publicKey),
        writable(pool.publicKey),
        writable(line.publicKey),
      ]),
    ),
    [payer, line, underwriter],
  );

  const drawSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ix(programId, drawData(6, 20_100), [
        signer(borrower.publicKey),
        writable(pool.publicKey),
        writable(line.publicKey),
      ]),
    ),
    [payer, borrower],
  );

  const repaySignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ix(programId, repayData(2, 20_500), [
        signer(borrower.publicKey),
        writable(pool.publicKey),
        writable(line.publicKey),
      ]),
    ),
    [payer, borrower],
  );

  const receiptSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: receipt.publicKey,
        lamports: receiptRent,
        space: RECEIPT_LEN,
        programId,
      }),
      ix(programId, receiptData(), [
        signer(auditor.publicKey),
        writable(line.publicKey),
        writable(receipt.publicKey),
      ]),
    ),
    [payer, receipt, auditor],
  );

  const settleSignature = await sendAndConfirmTransaction(
    connection,
    new Transaction().add(
      ix(programId, settleData(45_001), [writable(pool.publicKey), writable(line.publicKey)]),
    ),
    [payer],
  );

  const poolAccount = await getAccountData(connection, pool.publicKey);
  const lineAccount = await getAccountData(connection, line.publicKey);
  const receiptAccount = await getAccountData(connection, receipt.publicKey);

  const poolSnapshot = decodePool(poolAccount);
  const lineSnapshot = decodeLine(lineAccount);
  const receiptSnapshot = decodeReceipt(receiptAccount);
  const computeUnits = await collectComputeUnits(connection, programId, {
    initializePool: initSignature,
    approveCreditLine: approveSignature,
    drawTranche: drawSignature,
    repayTranche: repaySignature,
    postReceipt: receiptSignature,
    settleMaturity: settleSignature,
  });

  if (poolSnapshot.drawnNotes !== 6 || poolSnapshot.repaidNotes !== 2 || poolSnapshot.defaultedNotes !== 4) {
    throw new Error(`unexpected pool snapshot: ${JSON.stringify(poolSnapshot)}`);
  }
  if (lineSnapshot.status !== 4 || lineSnapshot.defaultedNotes !== 4) {
    throw new Error(`unexpected line snapshot: ${JSON.stringify(lineSnapshot)}`);
  }
  if (!receiptSnapshot.receiptHash.every((byte) => byte === 9)) {
    throw new Error(`unexpected receipt hash: ${receiptSnapshot.receiptHash.join(",")}`);
  }
  assertComputeUnits(computeUnits);

  console.log(
    JSON.stringify(
      {
        ok: true,
        rpcUrl: RPC_URL,
        programId: programId.toBase58(),
        accounts: {
          pool: pool.publicKey.toBase58(),
          line: line.publicKey.toBase58(),
          receipt: receipt.publicKey.toBase58(),
        },
        signatures: {
          initializePool: initSignature,
          approveCreditLine: approveSignature,
          drawTranche: drawSignature,
          repayTranche: repaySignature,
          postReceipt: receiptSignature,
          settleMaturity: settleSignature,
        },
        computeUnits,
        poolSnapshot,
        lineSnapshot,
        receiptSnapshot: {
          signer: receiptSnapshot.signer.toBase58(),
          periodStartSlot: receiptSnapshot.periodStartSlot,
          periodEndSlot: receiptSnapshot.periodEndSlot,
          acceptedSlot: receiptSnapshot.acceptedSlot,
        },
      },
      null,
      2,
    ),
  );
}

async function collectComputeUnits(
  connection: Connection,
  programId: PublicKey,
  signatures: Record<keyof typeof COMPUTE_LIMITS, string>,
) {
  const entries = await Promise.all(
    Object.entries(signatures).map(async ([name, signature]) => [
      name,
      await getProgramComputeUnits(connection, programId, signature),
    ]),
  );
  return Object.fromEntries(entries) as Record<keyof typeof COMPUTE_LIMITS, number>;
}

async function getProgramComputeUnits(connection: Connection, programId: PublicKey, signature: string) {
  const needle = `Program ${programId.toBase58()} consumed `;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const transaction = await connection.getTransaction(signature, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const consumedLog = transaction?.meta?.logMessages?.find((log) => log.includes(needle));
    const match = consumedLog?.match(/consumed (\d+) of/);
    if (match) return Number(match[1]);
    await sleep(250);
  }
  throw new Error(`program compute log not found for ${signature}`);
}

function assertComputeUnits(computeUnits: Record<keyof typeof COMPUTE_LIMITS, number>) {
  for (const [name, limit] of Object.entries(COMPUTE_LIMITS)) {
    const consumed = computeUnits[name as keyof typeof COMPUTE_LIMITS];
    if (consumed > limit) {
      throw new Error(`${name} consumed ${consumed} CU, over limit ${limit}`);
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ix(programId: PublicKey, data: Buffer, keys: { pubkey: PublicKey; isSigner: boolean; isWritable: boolean }[]) {
  return new TransactionInstruction({ programId, data, keys });
}

function signer(pubkey: PublicKey) {
  return { pubkey, isSigner: true, isWritable: false };
}

function writable(pubkey: PublicKey) {
  return { pubkey, isSigner: false, isWritable: true };
}

function initPoolData(underwriter: PublicKey, auditor: PublicKey, reserveMint: PublicKey, vault: PublicKey) {
  const writer = new Writer(1 + 1 + 1 + 32 * 4 + 8 + 4 + 2 + 8 + 8);
  writer.u8(0);
  writer.u8(251);
  writer.u8(3);
  writer.pubkey(underwriter);
  writer.pubkey(auditor);
  writer.pubkey(reserveMint);
  writer.pubkey(vault);
  writer.u64(1_000);
  writer.u32(100);
  writer.u16(75);
  writer.u64(50_000);
  writer.u64(150);
  return writer.done();
}

function approveLineData(borrower: PublicKey) {
  const writer = new Writer(1 + 32 + 4 + 32 + 32 + 8 + 8);
  writer.u8(1);
  writer.pubkey(borrower);
  writer.u32(10);
  writer.bytes(Buffer.alloc(32, 7));
  writer.bytes(Buffer.alloc(32, 8));
  writer.u64(20_000);
  writer.u64(45_000);
  return writer.done();
}

function drawData(notes: number, currentSlot: number) {
  const writer = new Writer(1 + 4 + 8);
  writer.u8(2);
  writer.u32(notes);
  writer.u64(currentSlot);
  return writer.done();
}

function repayData(notes: number, currentSlot: number) {
  const writer = new Writer(1 + 4 + 8);
  writer.u8(3);
  writer.u32(notes);
  writer.u64(currentSlot);
  return writer.done();
}

function receiptData() {
  const writer = new Writer(1 + 8 + 8 + 8 + 32);
  writer.u8(4);
  writer.u64(20_100);
  writer.u64(20_200);
  writer.u64(20_201);
  writer.bytes(Buffer.alloc(32, 9));
  return writer.done();
}

function settleData(currentSlot: number) {
  const writer = new Writer(1 + 8);
  writer.u8(5);
  writer.u64(currentSlot);
  return writer.done();
}

function decodePool(data: Buffer) {
  return {
    status: data.readUInt8(3),
    allocatedLimitNotes: data.readUInt32LE(208),
    outstandingNotes: data.readUInt32LE(212),
    drawnNotes: data.readUInt32LE(216),
    repaidNotes: data.readUInt32LE(220),
    defaultedNotes: data.readUInt32LE(224),
  };
}

function decodeLine(data: Buffer) {
  return {
    status: data.readUInt8(2),
    limitNotes: data.readUInt32LE(131),
    drawnNotes: data.readUInt32LE(135),
    repaidNotes: data.readUInt32LE(139),
    defaultedNotes: data.readUInt32LE(143),
    lastReceiptSlot: Number(data.readBigUInt64LE(173)),
  };
}

function decodeReceipt(data: Buffer) {
  return {
    signer: new PublicKey(data.subarray(34, 66)),
    periodStartSlot: Number(data.readBigUInt64LE(66)),
    periodEndSlot: Number(data.readBigUInt64LE(74)),
    acceptedSlot: Number(data.readBigUInt64LE(82)),
    receiptHash: [...data.subarray(90, 122)],
  };
}

async function ensureBalance(connection: Connection, pubkey: PublicKey) {
  const balance = await connection.getBalance(pubkey);
  if (balance >= LAMPORTS_PER_SOL / 10) return;
  const signature = await connection.requestAirdrop(pubkey, LAMPORTS_PER_SOL);
  await connection.confirmTransaction(signature, "confirmed");
}

async function getAccountData(connection: Connection, pubkey: PublicKey) {
  const account = await connection.getAccountInfo(pubkey, "confirmed");
  if (!account) throw new Error(`account not found: ${pubkey.toBase58()}`);
  return account.data;
}

function loadKeypair(path: string) {
  return Keypair.fromSecretKey(new Uint8Array(JSON.parse(readFileSync(path, "utf8"))));
}

class Writer {
  private readonly buffer: Buffer;
  private offset = 0;

  constructor(length: number) {
    this.buffer = Buffer.alloc(length);
  }

  u8(value: number) {
    this.buffer.writeUInt8(value, this.offset);
    this.offset += 1;
  }

  u16(value: number) {
    this.buffer.writeUInt16LE(value, this.offset);
    this.offset += 2;
  }

  u32(value: number) {
    this.buffer.writeUInt32LE(value, this.offset);
    this.offset += 4;
  }

  u64(value: number) {
    this.buffer.writeBigUInt64LE(BigInt(value), this.offset);
    this.offset += 8;
  }

  pubkey(value: PublicKey) {
    this.bytes(value.toBuffer());
  }

  bytes(value: Buffer) {
    value.copy(this.buffer, this.offset);
    this.offset += value.length;
  }

  done() {
    return this.buffer;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

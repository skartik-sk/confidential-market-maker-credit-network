/**
 * Instruction builders for the confidential-credit-vault program.
 * Matches the binary serialization format from programs/credit-vault/src/instruction.rs
 *
 * Program ID: G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5 (devnet)
 */

import {
  TransactionInstruction,
  PublicKey,
  SystemProgram,
  Connection,
  Transaction,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";

export const PROGRAM_ID = new PublicKey(
  "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5",
);

/* ------------------------------------------------------------------ */
/*  Account layouts (from state.rs)                                    */
/* ------------------------------------------------------------------ */

export const POOL_DISCRIMINATOR = 0x51;
export const LINE_DISCRIMINATOR = 0x52;
export const RECEIPT_DISCRIMINATOR = 0x53;

export const PoolAccountLayout = {
  LEN: 279,
  STATUS_OFFSET: 3,
  NOTE_SIZE_USD_OFFSET: 196,
  TOTAL_LIMIT_NOTES_OFFSET: 204,
  ALLOCATED_LIMIT_NOTES_OFFSET: 208,
  OUTSTANDING_NOTES_OFFSET: 212,
  TOTAL_DRAWN_NOTES_OFFSET: 216,
  TOTAL_REPAID_NOTES_OFFSET: 220,
  INTEREST_BPS_OFFSET: 228,
  MATURITY_SLOT_OFFSET: 230,
  PRIVACY_POLICY_OFFSET: 246,
};

export const CreditLineAccountLayout = {
  LEN: 278,
  STATUS_OFFSET: 2,
  POOL_OFFSET: 3,
  BORROWER_OFFSET: 35,
  UNDERWRITER_OFFSET: 67,
  AUDITOR_OFFSET: 99,
  LIMIT_NOTES_OFFSET: 131,
  DRAWN_NOTES_OFFSET: 135,
  REPAID_NOTES_OFFSET: 139,
  DEFAULTED_NOTES_OFFSET: 143,
  NOTE_SIZE_USD_OFFSET: 147,
  INTEREST_BPS_OFFSET: 155,
  MATURITY_SLOT_OFFSET: 165,
};

/* ------------------------------------------------------------------ */
/*  Enums                                                              */
/* ------------------------------------------------------------------ */

export enum PrivacyPolicy {
  PublicNotes = 0,
  UmbraPrivateSettlement = 1,
  ArciumPrivateRisk = 2,
  UmbraArcium = 3,
  MagicBlockPrivateEr = 4,
}

export enum LineStatus {
  Uninitialized = 0,
  Active = 1,
  Closed = 2,
  Delinquent = 3,
  Defaulted = 4,
  Paused = 5,
}

export enum PoolStatus {
  Uninitialized = 0,
  Active = 1,
  Paused = 2,
}

/* ------------------------------------------------------------------ */
/*  Instruction serializers                                            */
/* ------------------------------------------------------------------ */

/** Instruction 0: InitializePool */
export function createInitializePoolIx(params: {
  pool: PublicKey;
  admin: PublicKey;
  bump: number;
  privacyPolicy: PrivacyPolicy;
  underwriter: PublicKey;
  auditor: PublicKey;
  reserveMint: PublicKey;
  vault: PublicKey;
  noteSizeUsd: number;
  totalLimitNotes: number;
  interestBps: number;
  maturitySlot: number;
  receiptIntervalSlots: number;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 1 + 1 + 32 + 32 + 32 + 32 + 8 + 4 + 2 + 8 + 8);
  let offset = 0;
  data.writeUInt8(0, offset); offset += 1; // tag
  data.writeUInt8(params.bump, offset); offset += 1;
  data.writeUInt8(params.privacyPolicy, offset); offset += 1;
  data.set(params.underwriter.toBuffer(), offset); offset += 32;
  data.set(params.auditor.toBuffer(), offset); offset += 32;
  data.set(params.reserveMint.toBuffer(), offset); offset += 32;
  data.set(params.vault.toBuffer(), offset); offset += 32;
  data.writeBigUInt64LE(BigInt(params.noteSizeUsd), offset); offset += 8;
  data.writeUInt32LE(params.totalLimitNotes, offset); offset += 4;
  data.writeUInt16LE(params.interestBps, offset); offset += 2;
  data.writeBigUInt64LE(BigInt(params.maturitySlot), offset); offset += 8;
  data.writeBigUInt64LE(BigInt(params.receiptIntervalSlots), offset); offset += 8;

  return new TransactionInstruction({
    keys: [
      { pubkey: params.pool, isSigner: false, isWritable: true },
      { pubkey: params.admin, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/** Instruction 1: ApproveCreditLine */
export function createApproveCreditLineIx(params: {
  pool: PublicKey;
  creditLine: PublicKey;
  underwriter: PublicKey;
  borrower: PublicKey;
  limitNotes: number;
  termsHash: PublicKey;
  mandateHash: PublicKey;
  openedSlot: number;
  maturitySlot: number;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 32 + 4 + 32 + 32 + 8 + 8);
  let offset = 0;
  data.writeUInt8(1, offset); offset += 1; // tag
  data.set(params.borrower.toBuffer(), offset); offset += 32;
  data.writeUInt32LE(params.limitNotes, offset); offset += 4;
  data.set(params.termsHash.toBuffer(), offset); offset += 32;
  data.set(params.mandateHash.toBuffer(), offset); offset += 32;
  data.writeBigUInt64LE(BigInt(params.openedSlot), offset); offset += 8;
  data.writeBigUInt64LE(BigInt(params.maturitySlot), offset); offset += 8;

  return new TransactionInstruction({
    keys: [
      { pubkey: params.pool, isSigner: false, isWritable: true },
      { pubkey: params.creditLine, isSigner: false, isWritable: true },
      { pubkey: params.underwriter, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/** Instruction 2: DrawTranche */
export function createDrawTrancheIx(params: {
  pool: PublicKey;
  creditLine: PublicKey;
  borrower: PublicKey;
  notes: number;
  currentSlot: number;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 4 + 8);
  let offset = 0;
  data.writeUInt8(2, offset); offset += 1; // tag
  data.writeUInt32LE(params.notes, offset); offset += 4;
  data.writeBigUInt64LE(BigInt(params.currentSlot), offset); offset += 8;

  return new TransactionInstruction({
    keys: [
      { pubkey: params.pool, isSigner: false, isWritable: true },
      { pubkey: params.creditLine, isSigner: false, isWritable: true },
      { pubkey: params.borrower, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/** Instruction 3: RepayTranche */
export function createRepayTrancheIx(params: {
  pool: PublicKey;
  creditLine: PublicKey;
  borrower: PublicKey;
  notes: number;
  currentSlot: number;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 4 + 8);
  let offset = 0;
  data.writeUInt8(3, offset); offset += 1; // tag
  data.writeUInt32LE(params.notes, offset); offset += 4;
  data.writeBigUInt64LE(BigInt(params.currentSlot), offset); offset += 8;

  return new TransactionInstruction({
    keys: [
      { pubkey: params.pool, isSigner: false, isWritable: true },
      { pubkey: params.creditLine, isSigner: false, isWritable: true },
      { pubkey: params.borrower, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/** Instruction 5: SettleMaturity */
export function createSettleMaturityIx(params: {
  pool: PublicKey;
  creditLine: PublicKey;
  currentSlot: number;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 8);
  let offset = 0;
  data.writeUInt8(5, offset); offset += 1;
  data.writeBigUInt64LE(BigInt(params.currentSlot), offset); offset += 8;

  return new TransactionInstruction({
    keys: [
      { pubkey: params.pool, isSigner: false, isWritable: true },
      { pubkey: params.creditLine, isSigner: false, isWritable: true },
    ],
    programId: PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/** Instruction 6: PauseLine */
export function createPauseLineIx(params: {
  creditLine: PublicKey;
  underwriter: PublicKey;
  targetStatus: LineStatus;
}): TransactionInstruction {
  const data = Buffer.alloc(1 + 1);
  let offset = 0;
  data.writeUInt8(6, offset); offset += 1;
  data.writeUInt8(params.targetStatus, offset); offset += 1;

  return new TransactionInstruction({
    keys: [
      { pubkey: params.creditLine, isSigner: false, isWritable: true },
      { pubkey: params.underwriter, isSigner: true, isWritable: false },
    ],
    programId: PROGRAM_ID,
    data: data.subarray(0, offset),
  });
}

/* ------------------------------------------------------------------ */
/*  Account parsers                                                    */
/* ------------------------------------------------------------------ */

export function parsePoolAccount(data: Buffer) {
  if (data[0] !== POOL_DISCRIMINATOR) return null;
  let offset = 1;
  const version = data.readUInt8(offset); offset += 1;
  const bump = data.readUInt8(offset); offset += 1;
  const status = data.readUInt8(offset) as PoolStatus; offset += 1;
  const poolId = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const admin = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const underwriter = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const auditor = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const reserveMint = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const vault = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const noteSizeUsd = Number(data.readBigUInt64LE(offset)); offset += 8;
  const totalLimitNotes = data.readUInt32LE(offset); offset += 4;
  const allocatedLimitNotes = data.readUInt32LE(offset); offset += 4;
  const outstandingNotes = data.readUInt32LE(offset); offset += 4;
  const totalDrawnNotes = data.readUInt32LE(offset); offset += 4;
  const totalRepaidNotes = data.readUInt32LE(offset); offset += 4;
  const totalDefaultedNotes = data.readUInt32LE(offset); offset += 4;
  const interestBps = data.readUInt16LE(offset); offset += 2;
  const maturitySlot = Number(data.readBigUInt64LE(offset)); offset += 8;
  const receiptIntervalSlots = Number(data.readBigUInt64LE(offset)); offset += 8;
  const privacyPolicy = data.readUInt8(offset) as PrivacyPolicy;

  return {
    version, bump, status, poolId, admin, underwriter, auditor,
    reserveMint, vault, noteSizeUsd, totalLimitNotes, allocatedLimitNotes,
    outstandingNotes, totalDrawnNotes, totalRepaidNotes, totalDefaultedNotes,
    interestBps, maturitySlot, receiptIntervalSlots, privacyPolicy,
  };
}

export function parseCreditLineAccount(data: Buffer) {
  if (data[0] !== LINE_DISCRIMINATOR) return null;
  let offset = 1;
  const version = data.readUInt8(offset); offset += 1;
  const status = data.readUInt8(offset) as LineStatus; offset += 1;
  const pool = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const borrower = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const underwriter = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const auditor = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const limitNotes = data.readUInt32LE(offset); offset += 4;
  const drawnNotes = data.readUInt32LE(offset); offset += 4;
  const repaidNotes = data.readUInt32LE(offset); offset += 4;
  const defaultedNotes = data.readUInt32LE(offset); offset += 4;
  const noteSizeUsd = Number(data.readBigUInt64LE(offset)); offset += 8;
  const interestBps = data.readUInt16LE(offset); offset += 2;
  const openedSlot = Number(data.readBigUInt64LE(offset)); offset += 8;
  const maturitySlot = Number(data.readBigUInt64LE(offset)); offset += 8;
  const lastReceiptSlot = Number(data.readBigUInt64LE(offset)); offset += 8;
  const termsHash = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const mandateHash = new PublicKey(data.subarray(offset, offset + 32)); offset += 32;
  const privacyPolicy = data.readUInt8(offset) as PrivacyPolicy;

  return {
    version, status, pool, borrower, underwriter, auditor,
    limitNotes, drawnNotes, repaidNotes, defaultedNotes,
    noteSizeUsd, interestBps, openedSlot, maturitySlot,
    lastReceiptSlot, termsHash, mandateHash, privacyPolicy,
  };
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

export async function airdropSol(connection: Connection, pubkey: PublicKey, sol: number = 1) {
  const sig = await connection.requestAirdrop(pubkey, sol * LAMPORTS_PER_SOL);
  await connection.confirmTransaction(sig, "confirmed");
  return sig;
}

export async function getSlot(connection: Connection): Promise<number> {
  const slot = await connection.getSlot("confirmed");
  return slot;
}

export function statusLabel(s: LineStatus): string {
  const m: Record<number, string> = { 0: "uninitialized", 1: "active", 2: "closed", 3: "delinquent", 4: "defaulted", 5: "paused" };
  return m[s] || `${s}`;
}

export function poolStatusLabel(s: PoolStatus): string {
  const m: Record<number, string> = { 0: "uninitialized", 1: "active", 2: "paused" };
  return m[s] || `${s}`;
}

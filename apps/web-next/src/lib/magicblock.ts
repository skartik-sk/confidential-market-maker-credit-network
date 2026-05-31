/**
 * MagicBlock ER delegation integration for the confidential-credit-vault.
 *
 * Delegates a credit-line account to a MagicBlock Enhanced Rollup validator
 * so it can be used in sub-millisecond private sessions, then committed back
 * to the on-chain vault.
 *
 * Delegation flows through MagicBlock's DELEGATION_PROGRAM (not the credit-
 * vault program itself). The vault program only exposes commit/undelegate
 * instructions (indices 8 and 9) that operate on the already-delegated state.
 */

import {
  PublicKey,
  TransactionInstruction,
  Connection,
  SYSVAR_RENT_PUBKEY,
  SystemProgram,
} from "@solana/web3.js";

/* ------------------------------------------------------------------ */
/*  Constants                                                          */
/* ------------------------------------------------------------------ */

/** MagicBlock delegation program on devnet. */
export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMRRSaeSh",
);

/** MagicBlock Enhanced Rollup RPC endpoint (devnet). */
export const ER_RPC_URL = "https://devnet-as.magicblock.app";

/** MagicBlock TEE RPC endpoint (devnet). */
export const TEE_RPC_URL = "https://devnet-tee.magicblock.app";

/** Asia-Pacific validator (devnet). */
export const VALIDATOR_ASIA = new PublicKey(
  "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
);

/** TEE validator (devnet). */
export const VALIDATOR_TEE = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
);

/* ------------------------------------------------------------------ */
/*  PDAs                                                               */
/* ------------------------------------------------------------------ */

/**
 * Derive the delegation record PDA for a given credit-line account.
 *
 * Seeds: ["delegation_record", creditLine]
 */
export function delegationRecordPda(creditLine: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("delegation_record"), creditLine.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

/**
 * Derive the commit record PDA (used internally by MagicBlock).
 *
 * Seeds: ["commit_record", creditLine]
 */
export function commitRecordPda(creditLine: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("commit_record"), creditLine.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

/**
 * Derive the MagicBlock ER authority PDA for a given owner.
 *
 * Seeds: ["er_authority", owner]
 */
export function erAuthorityPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("er_authority"), owner.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

/* ------------------------------------------------------------------ */
/*  Delegation instruction                                             */
/* ------------------------------------------------------------------ */

/**
 * Create a delegation instruction that delegates a credit-line account to a
 * MagicBlock ER validator.
 *
 * The delegation data format (from mb.rs):
 *   - commit_frequency_ms : u32   (u32::MAX = never auto-commit)
 *   - seeds_length        : u8    (1)
 *   - seed_len            : u8    (11, length of "credit_line")
 *   - seed_data           : bytes ("credit_line")
 *   - is_some             : u8    (1 = validator specified)
 *   - validator           : 32 bytes
 *
 * This is instruction index 0 (Delegate) on the DELEGATION_PROGRAM.
 *
 * Required accounts (in order):
 *   0. credit_line        (writable, the account to delegate)
 *   1. owner              (signer, authority over the credit line)
 *   2. delegation_record  (writable, PDA)
 *   3. delegation_program (program ID)
 *   4. system_program
 */
export function delegateCreditLine(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
  validator: PublicKey;
}): TransactionInstruction {
  const {
    creditLine,
    owner,
    programId, // the credit-vault program that owns the credit-line account
    validator,
  } = params;

  const delegationRecord = delegationRecordPda(creditLine);

  // Build instruction data
  const seedLabel = "credit_line";
  const seedBuf = Buffer.from(seedLabel);
  // Layout: commit_frequency_ms(4) + seeds_length(1) + seed_len(1) + seed(11) + is_some(1) + validator(32)
  const data = Buffer.alloc(4 + 1 + 1 + seedBuf.length + 1 + 32);
  let offset = 0;

  // commit_frequency_ms: u32::MAX means no auto-commit (manual commit only)
  data.writeUInt32LE(0xffffffff, offset);
  offset += 4;

  // seeds_length: 1 (single seed)
  data.writeUInt8(1, offset);
  offset += 1;

  // seed_len: length of "credit_line" = 11
  data.writeUInt8(seedBuf.length, offset);
  offset += 1;

  // seed_data: "credit_line" bytes
  seedBuf.copy(data, offset);
  offset += seedBuf.length;

  // is_some: 1 (validator is specified)
  data.writeUInt8(1, offset);
  offset += 1;

  // validator: 32 bytes
  validator.toBuffer().copy(data, offset);
  offset += 32;

  return new TransactionInstruction({
    keys: [
      { pubkey: creditLine, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: delegationRecord, isSigner: false, isWritable: true },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    programId,
    data: data.subarray(0, offset),
  });
}

/* ------------------------------------------------------------------ */
/*  Commit instruction (index 8 on credit-vault program)               */
/* ------------------------------------------------------------------ */

/**
 * Create a commit instruction that commits the ER state of a credit-line
 * back to the on-chain vault.
 *
 * Instruction index 8 on the credit-vault program.
 * Data: u32 LE = 1 (commit flag).
 *
 * Required accounts:
 *   0. credit_line        (writable)
 *   1. owner              (signer)
 */
export function commitCreditLine(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
}): TransactionInstruction {
  const { creditLine, owner, programId } = params;

  // Instruction tag 8 + data payload (u32 LE = 1)
  const data = Buffer.alloc(1 + 4);
  let offset = 0;
  data.writeUInt8(8, offset);
  offset += 1;
  data.writeUInt32LE(1, offset);
  offset += 4;

  return new TransactionInstruction({
    keys: [
      { pubkey: creditLine, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId,
    data: data.subarray(0, offset),
  });
}

/* ------------------------------------------------------------------ */
/*  Commit + Undelegate instruction (index 9)                          */
/* ------------------------------------------------------------------ */

/**
 * Create a commit-and-undelegate instruction.
 *
 * Instruction index 9 on the credit-vault program.
 * Data: u32 LE = 2 (commit + undelegate).
 *
 * Required accounts:
 *   0. credit_line        (writable)
 *   1. owner              (signer)
 *   2. delegation_record  (writable, PDA)
 *   3. delegation_program
 */
export function commitAndUndelegate(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
}): TransactionInstruction {
  const { creditLine, owner, programId } = params;
  const delegationRecord = delegationRecordPda(creditLine);

  // Instruction tag 9 + data payload (u32 LE = 2)
  const data = Buffer.alloc(1 + 4);
  let offset = 0;
  data.writeUInt8(9, offset);
  offset += 1;
  data.writeUInt32LE(2, offset);
  offset += 4;

  return new TransactionInstruction({
    keys: [
      { pubkey: creditLine, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
      { pubkey: delegationRecord, isSigner: false, isWritable: true },
      { pubkey: DELEGATION_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    programId,
    data: data.subarray(0, offset),
  });
}

/* ------------------------------------------------------------------ */
/*  Delegation status reader                                           */
/* ------------------------------------------------------------------ */

export interface DelegationStatus {
  /** Whether the credit line is currently delegated. */
  delegated: boolean;
  /** The delegation record PDA address. */
  recordAddress: PublicKey;
  /** The validator the account is delegated to (if any). */
  validator: PublicKey | null;
  /** The commit frequency in ms (u32::MAX = manual only). */
  commitFrequencyMs: number | null;
  /** Slot at which the delegation was created. */
  slot: number | null;
}

/**
 * Check whether a credit-line account is currently delegated to a MagicBlock
 * ER validator by reading the delegation record PDA.
 */
export async function getDelegationStatus(
  connection: Connection,
  creditLine: PublicKey,
): Promise<DelegationStatus> {
  const recordAddress = delegationRecordPda(creditLine);

  const accountInfo = await connection.getAccountInfo(recordAddress);

  if (!accountInfo || accountInfo.data.length === 0) {
    return {
      delegated: false,
      recordAddress,
      validator: null,
      commitFrequencyMs: null,
      slot: null,
    };
  }

  // Parse delegation record (MagicBlock format):
  // discriminator (8) | commit_frequency_ms (4) | ... | validator (32)
  const data = accountInfo.data;
  let offset = 8; // skip discriminator

  const commitFrequencyMs = data.readUInt32LE(offset);
  offset += 4;

  // Skip past seed info to find the validator field.
  // Layout after commit_frequency_ms:
  //   seeds_length (1) | [seed_len (1) | seed_data (N)]* | is_some (1) | validator? (32)
  const seedsLength = data.readUInt8(offset);
  offset += 1;

  for (let i = 0; i < seedsLength; i++) {
    const seedLen = data.readUInt8(offset);
    offset += 1;
    offset += seedLen;
  }

  const isSome = data.readUInt8(offset);
  offset += 1;

  let validator: PublicKey | null = null;
  if (isSome === 1 && offset + 32 <= data.length) {
    validator = new PublicKey(data.subarray(offset, offset + 32));
  }

  return {
    delegated: true,
    recordAddress,
    validator,
    commitFrequencyMs,
    slot: null, // slot is not directly in the delegation record
  };
}

/* ------------------------------------------------------------------ */
/*  Helper: full delegation flow                                       */
/* ------------------------------------------------------------------ */

/**
 * Build a complete delegate-and-commit transaction flow.
 *
 * Returns an object with all the instructions and PDAs needed for a full
 * delegation lifecycle: delegate -> (use in ER) -> commit -> undelegate.
 */
export function buildDelegationFlow(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
  validator?: PublicKey;
}): {
  delegateIx: TransactionInstruction;
  commitIx: TransactionInstruction;
  commitAndUndelegateIx: TransactionInstruction;
  delegationRecord: PublicKey;
} {
  const validator = params.validator ?? VALIDATOR_ASIA;

  return {
    delegateIx: delegateCreditLine({ ...params, validator }),
    commitIx: commitCreditLine(params),
    commitAndUndelegateIx: commitAndUndelegate(params),
    delegationRecord: delegationRecordPda(params.creditLine),
  };
}

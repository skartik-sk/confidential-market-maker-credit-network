/**
 * MagicBlock ER delegation integration for the confidential-credit-vault.
 *
 * All three delegation instructions route THROUGH the credit-vault program
 * (tags 7/8/9), which performs the MagicBlock delegation CPI internally
 * (programs/credit-vault/src/mb.rs). The client must pass the exact account
 * lists the on-chain handlers destructure:
 *
 *   DelegateCreditLine  (tag 7) -> 7 accounts (see delegateCreditLine)
 *   CommitCreditLine    (tag 8) -> 4 accounts (see commitCreditLine)
 *   CommitAndUndelegate (tag 9) -> 4 accounts (see commitAndUndelegate)
 *
 * Requires MagicBlock's delegation + magic programs to be deployed on the
 * cluster (present on devnet). Seeds/validator are pinned in the program.
 */

import { PublicKey, TransactionInstruction, Connection } from "@solana/web3.js";

/* ------------------------------------------------------------------ */
/*  Constants (mirror programs/credit-vault/src/mb.rs)                 */
/* ------------------------------------------------------------------ */

/** MagicBlock delegation program. */
export const DELEGATION_PROGRAM_ID = new PublicKey(
  "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMRRSaeSh",
);
/** MagicBlock magic program (commit/undelegate target). */
export const MAGIC_PROGRAM_ID = new PublicKey(
  "Magic11111111111111111111111111111111111111",
);
/** MagicBlock context account. */
export const MAGIC_CONTEXT_ID = new PublicKey(
  "MagicContext1111111111111111111111111111111",
);
/** System program. */
const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111",
);

/** MagicBlock Enhanced Rollup RPC endpoint (devnet, Asia). */
export const ER_RPC_URL = "https://devnet-as.magicblock.app";
/** MagicBlock TEE RPC endpoint (devnet). */
export const TEE_RPC_URL = "https://devnet-tee.magicblock.app";

/** Asia-Pacific validator (devnet) — pinned in the program. */
export const VALIDATOR_ASIA = new PublicKey(
  "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
);
/** TEE validator (devnet). */
export const VALIDATOR_TEE = new PublicKey(
  "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
);

/* ------------------------------------------------------------------ */
/*  PDAs (seeds MUST match mb.rs exactly)                              */
/* ------------------------------------------------------------------ */

const SEED_DELEGATION = "delegation";
const SEED_DELEGATION_METADATA = "delegation-metadata";
const SEED_BUFFER = "buffer";

/** Delegation record PDA: ["delegation", creditLine] on DELEGATION_PROGRAM. */
export function delegationRecordPda(creditLine: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_DELEGATION), creditLine.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

/** Delegation metadata PDA: ["delegation-metadata", creditLine] on DELEGATION_PROGRAM. */
export function delegationMetadataPda(creditLine: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_DELEGATION_METADATA), creditLine.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

/** Delegate buffer PDA: ["buffer", creditLine] on the CREDIT-VAULT program. */
export function delegateBufferPda(creditLine: PublicKey, ownerProgram: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from(SEED_BUFFER), creditLine.toBuffer()],
    ownerProgram,
  )[0];
}

/** ER authority PDA (convenience, unused by current handlers). */
export function erAuthorityPda(owner: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("er_authority"), owner.toBuffer()],
    DELEGATION_PROGRAM_ID,
  )[0];
}

/* ------------------------------------------------------------------ */
/*  Instruction 7: DelegateCreditLine (routes through credit-vault)    */
/* ------------------------------------------------------------------ */

/**
 * Delegate a credit-line account to a MagicBlock ER validator.
 *
 * The credit-vault program's DelegateCreditLine handler (tag 7) calls
 * mb.rs::delegate_account, which destructures 7 accounts:
 *   0. payer            = owner (signer, writable)
 *   1. pda_acc          = credit line (writable)
 *   2. owner_program    = credit-vault program (readonly)
 *   3. buffer_acc       = delegate buffer PDA (writable)
 *   4. delegation_record  (writable)
 *   5. delegation_metadata (writable)
 *   6. system_program   (readonly)
 *
 * The validator + seeds are pinned in the program (VALIDATOR_ASIA,
 * "credit_line"). Data is just the tag byte [7].
 */
export function delegateCreditLine(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey; // credit-vault program id
}): TransactionInstruction {
  const { creditLine, owner, programId } = params;
  const buffer = delegateBufferPda(creditLine, programId);
  const delegationRecord = delegationRecordPda(creditLine);
  const delegationMetadata = delegationMetadataPda(creditLine);

  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },            // 0 payer
      { pubkey: creditLine, isSigner: false, isWritable: true },      // 1 pda
      { pubkey: programId, isSigner: false, isWritable: false },      // 2 owner_program
      { pubkey: buffer, isSigner: false, isWritable: true },          // 3 buffer
      { pubkey: delegationRecord, isSigner: false, isWritable: true },// 4 record
      { pubkey: delegationMetadata, isSigner: false, isWritable: true },// 5 metadata
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },// 6 system
    ],
    programId,
    data: Buffer.from([7]),
  });
}

/* ------------------------------------------------------------------ */
/*  Instruction 8: CommitCreditLine                                    */
/* ------------------------------------------------------------------ */

/**
 * Commit the ER state of a credit-line back on-chain.
 *
 * CommitCreditLine handler (tag 8) -> mb.rs::commit_accounts, which
 * destructures 4 accounts:
 *   0. payer         = owner (signer, writable)
 *   1. committed_acc = credit line (writable)
 *   2. magic_program (readonly)
 *   3. magic_context (writable)
 *
 * Data is just the tag byte [8].
 */
export function commitCreditLine(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
}): TransactionInstruction {
  const { creditLine, owner, programId } = params;
  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: creditLine, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ],
    programId,
    data: Buffer.from([8]),
  });
}

/* ------------------------------------------------------------------ */
/*  Instruction 9: CommitAndUndelegateCreditLine                       */
/* ------------------------------------------------------------------ */

/**
 * Commit and undelegate in one instruction.
 *
 * CommitAndUndelegate handler (tag 9) -> mb.rs::commit_and_undelegate,
 * same 4-account contract as commit. Data is just [9].
 */
export function commitAndUndelegate(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
}): TransactionInstruction {
  const { creditLine, owner, programId } = params;
  return new TransactionInstruction({
    keys: [
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: creditLine, isSigner: false, isWritable: true },
      { pubkey: MAGIC_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: MAGIC_CONTEXT_ID, isSigner: false, isWritable: true },
    ],
    programId,
    data: Buffer.from([9]),
  });
}

/* ------------------------------------------------------------------ */
/*  Delegation status reader                                           */
/* ------------------------------------------------------------------ */

export interface DelegationStatus {
  delegated: boolean;
  recordAddress: PublicKey;
  /** Validator the account is delegated to, if parseable. */
  validator: PublicKey | null;
  commitFrequencyMs: number | null;
}

/**
 * Check delegation status by reading the delegation record PDA.
 *
 * NOTE: the delegation record is written by MagicBlock's delegation program
 * (Anchor layout). We conservatively report `delegated: true` only when a
 * record account exists, and do not over-parse its body.
 */
export async function getDelegationStatus(
  connection: Connection,
  creditLine: PublicKey,
): Promise<DelegationStatus> {
  const recordAddress = delegationRecordPda(creditLine);
  const accountInfo = await connection.getAccountInfo(recordAddress);
  if (!accountInfo || accountInfo.data.length === 0) {
    return { delegated: false, recordAddress, validator: null, commitFrequencyMs: null };
  }
  return { delegated: true, recordAddress, validator: VALIDATOR_ASIA, commitFrequencyMs: null };
}

/* ------------------------------------------------------------------ */
/*  Full delegation flow (convenience)                                 */
/* ------------------------------------------------------------------ */

export function buildDelegationFlow(params: {
  creditLine: PublicKey;
  owner: PublicKey;
  programId: PublicKey;
}): {
  delegateIx: TransactionInstruction;
  commitIx: TransactionInstruction;
  commitAndUndelegateIx: TransactionInstruction;
  delegationRecord: PublicKey;
  buffer: PublicKey;
  delegationMetadata: PublicKey;
} {
  return {
    delegateIx: delegateCreditLine(params),
    commitIx: commitCreditLine(params),
    commitAndUndelegateIx: commitAndUndelegate(params),
    delegationRecord: delegationRecordPda(params.creditLine),
    buffer: delegateBufferPda(params.creditLine, params.programId),
    delegationMetadata: delegationMetadataPda(params.creditLine),
  };
}

/**
 * Commitment registry — seals a commitment receipt hash on-chain.
 *
 * The zk module computes a hash over a batch of shielded-note commitments;
 * this module anchors that hash to the borrower's credit line via the
 * credit-vault program's PostReceipt instruction (tag 4), producing a
 * publicly-verifiable, tamper-evident audit trail WITHOUT revealing the
 * commitments themselves.
 *
 * On-chain contract (programs/credit-vault/src):
 *  - Accounts: [signer, creditLine (writable), receipt (writable)]
 *    — see processor.rs CreditVaultInstruction::PostReceipt. The pool PDA is
 *    NOT required for PostReceipt; the signer must be the line's auditor or
 *    underwriter.
 *  - The receipt account must be a program-owned, writable, UNINITIALIZED
 *    account. There is no program-side create instruction, so we fund a
 *    deterministic program-owned account with SystemProgram.createAccountWithSeed
 *    (base = wallet, so only the wallet signature is needed).
 *
 * Args (instruction.rs, all little-endian):
 *   tag: u8 = 4, period_start_slot: u64, period_end_slot: u64,
 *   accepted_slot: u64, receipt_hash: [u8; 32]
 */

import {
  Connection,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { sha256 } from "@noble/hashes/sha256";
import { bytesToHex } from "@noble/hashes/utils";
import {
  PROGRAM_ID,
  RECEIPT_DISCRIMINATOR,
  ReceiptAccountLayout,
  createPostReceiptIx,
  parseCreditLineAccount,
} from "@/lib/program";

const HEX64_RE = /^[0-9a-f]{64}$/;

/* ------------------------------------------------------------------ */
/*  Hashing                                                            */
/* ------------------------------------------------------------------ */

/**
 * SHA-256 over the concatenated lowercase hex commitment strings.
 * Returns the digest as a 64-char lowercase hex string.
 */
export function receiptHashFromCommitments(commitmentHexes: string[]): string {
  const concatenated = commitmentHexes
    .map((c) => c.trim().replace(/^0x/i, "").toLowerCase())
    .join("");
  return bytesToHex(sha256(new TextEncoder().encode(concatenated)));
}

/* ------------------------------------------------------------------ */
/*  On-chain sealing                                                   */
/* ------------------------------------------------------------------ */

/** Deterministic per-(wallet, credit line) receipt seed (≤ MAX_SEED_LENGTH). */
function receiptSeed(creditLine: PublicKey): string {
  // "rcpt" (4) + 26 hex chars = 30 chars ≤ 32-byte seed limit.
  return `rcpt${bytesToHex(sha256(creditLine.toBytes())).slice(0, 26)}`;
}

export async function sealCommitmentsOnChain(
  connection: Connection,
  wallet: { publicKey: PublicKey | null; signTransaction: (tx: Transaction) => Promise<Transaction> },
  params: { creditLineAddress: string; receiptHashHex: string },
): Promise<string | null> {
  if (!wallet?.publicKey || typeof wallet.signTransaction !== "function") {
    throw new Error("A connected wallet with publicKey and signTransaction is required to seal commitments");
  }
  const payer = wallet.publicKey;

  // Required account: the credit line under audit.
  let creditLine: PublicKey;
  try {
    creditLine = new PublicKey(params.creditLineAddress);
  } catch {
    console.info("commitment-registry: cannot derive credit line account from", params.creditLineAddress);
    return null;
  }

  // receipt_hash arg: exactly 32 bytes of hex.
  const hashHex = params.receiptHashHex.trim().replace(/^0x/i, "").toLowerCase();
  if (!HEX64_RE.test(hashHex)) {
    console.info("commitment-registry: receiptHashHex must be 64 hex chars (32 bytes)");
    return null;
  }
  const receiptHash = new PublicKey(new Uint8Array(Buffer.from(hashHex, "hex")));

  // Required account: the receipt (program-owned, uninitialized, writable).
  // PostReceipt does not need the pool PDA — see processor.rs.
  const seed = receiptSeed(creditLine);
  const receipt = await PublicKey.createWithSeed(payer, seed, PROGRAM_ID);

  const tx = new Transaction();
  const existing = await connection.getAccountInfo(receipt);
  if (existing && existing.data.length >= ReceiptAccountLayout.LEN) {
    if (existing.data[0] === RECEIPT_DISCRIMINATOR) {
      console.info("commitment-registry: receipt already sealed for this credit line and wallet");
      return null;
    }
    // Allocated but uninitialized — reusable as-is.
  } else if (existing && existing.lamports > 0) {
    console.info("commitment-registry: receipt account exists but is not usable for a receipt");
    return null;
  } else {
    // Unfunded: create it program-owned in the same transaction.
    const lamports = await connection.getMinimumBalanceForRentExemption(ReceiptAccountLayout.LEN);
    tx.add(
      SystemProgram.createAccountWithSeed({
        fromPubkey: payer,
        newAccountPubkey: receipt,
        basePubkey: payer,
        seed,
        lamports,
        space: ReceiptAccountLayout.LEN,
        programId: PROGRAM_ID,
      }),
    );
  }

  // Slots: continue the line's receipt timeline when readable, else "now".
  const slot = await connection.getSlot("confirmed");
  let periodStartSlot = slot;
  try {
    const lineInfo = await connection.getAccountInfo(creditLine);
    if (lineInfo) {
      const line = parseCreditLineAccount(Buffer.from(lineInfo.data));
      if (line && line.lastReceiptSlot > 0 && line.lastReceiptSlot <= slot) {
        periodStartSlot = line.lastReceiptSlot;
      }
    }
  } catch {
    // Best-effort timeline continuation; the program validates slot ordering.
  }

  tx.add(
    createPostReceiptIx({
      signer: payer,
      creditLine,
      receipt,
      periodStartSlot,
      periodEndSlot: slot,
      acceptedSlot: slot,
      receiptHash,
    }),
  );

  tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  tx.feePayer = payer;

  const signed = await wallet.signTransaction(tx);
  const signature = await connection.sendRawTransaction(signed.serialize());
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

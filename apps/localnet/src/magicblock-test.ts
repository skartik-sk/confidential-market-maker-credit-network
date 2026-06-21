/**
 * MagicBlock client instruction builder tests.
 *
 * Proves the three delegation instructions (tags 7/8/9) route through the
 * credit-vault program with the EXACT account lists the on-chain handlers in
 * processor.rs / mb.rs destructure. Catches the class of bugs the previous
 * version had (wrong program target, wrong account counts, u8/u32 drift).
 *
 * Run:  bun run apps/localnet/src/magicblock-test.ts
 */

import { Keypair, PublicKey } from "@solana/web3.js";
import {
  delegateCreditLine, commitCreditLine, commitAndUndelegate,
  delegationRecordPda, delegationMetadataPda, delegateBufferPda,
  DELEGATION_PROGRAM_ID, MAGIC_PROGRAM_ID, MAGIC_CONTEXT_ID,
} from "../../web-next/src/lib/magicblock";

let passed = 0, failed = 0;
const ok = (m: string) => { passed++; console.log(`  ✅ ${m}`); };
const bad = (m: string) => { failed++; console.log(`  ❌ ${m}`); };

const PROGRAM_ID = new PublicKey("G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5");
const line = Keypair.generate().publicKey;
const owner = Keypair.generate().publicKey;
const SYSTEM = new PublicKey("11111111111111111111111111111111");

console.log("\n🪄 MagicBlock Instruction Builder Tests\n");

// --- Delegate (tag 7): 7 accounts, targets credit-vault program, data = [7] ---
console.log("Delegate (tag 7):");
const dIx = delegateCreditLine({ creditLine: line, owner, programId: PROGRAM_ID });
dIx.programId.equals(PROGRAM_ID) ? ok("targets credit-vault program (not delegation program)") : bad("wrong program");
dIx.data.length === 1 && dIx.data[0] === 7 ? ok("data = [7] (unit variant, seeds pinned in program)") : bad(`data = [${[...dIx.data]}]`);
dIx.keys.length === 7 ? ok(`7 accounts (mb.rs::delegate_account expects 7)`) : bad(`${dIx.keys.length} accounts`);
// Account contract checks (mirror mb.rs destructuring)
const want = [
  { i: 0, role: "payer", pk: owner, signer: true, writable: true },
  { i: 1, role: "pda(line)", pk: line, signer: false, writable: true },
  { i: 2, role: "owner_program", pk: PROGRAM_ID, signer: false, writable: false },
  { i: 6, role: "system", pk: SYSTEM, signer: false, writable: false },
];
for (const w of want) {
  const k = dIx.keys[w.i];
  k.pubkey.equals(w.pk) && k.isSigner === w.signer && k.isWritable === w.writable
    ? ok(`acct[${w.i}] = ${w.role} (signer=${w.signer}, writable=${w.writable})`)
    : bad(`acct[${w.i}] wrong: got ${k.pubkey.toBase58().slice(0,8)} signer=${k.isSigner} writable=${k.isWritable}`);
}
// Buffer + record + metadata PDAs at correct indices
dIx.keys[3].pubkey.equals(delegateBufferPda(line, PROGRAM_ID)) ? ok("acct[3] = buffer PDA") : bad("buffer PDA mismatch");
dIx.keys[4].pubkey.equals(delegationRecordPda(line)) ? ok("acct[4] = delegation record PDA") : bad("record PDA mismatch");
dIx.keys[5].pubkey.equals(delegationMetadataPda(line)) ? ok("acct[5] = delegation metadata PDA") : bad("metadata PDA mismatch");

// --- Commit (tag 8): 4 accounts ---
console.log("\nCommit (tag 8):");
const cIx = commitCreditLine({ creditLine: line, owner, programId: PROGRAM_ID });
cIx.programId.equals(PROGRAM_ID) ? ok("targets credit-vault program") : bad("wrong program");
cIx.data.length === 1 && cIx.data[0] === 8 ? ok("data = [8]") : bad(`data = [${[...cIx.data]}]`);
cIx.keys.length === 4 ? ok("4 accounts (mb.rs::commit_accounts expects 4)") : bad(`${cIx.keys.length} accounts`);
cIx.keys[0].pubkey.equals(owner) && cIx.keys[0].isSigner ? ok("acct[0] = payer (signer)") : bad("payer wrong");
cIx.keys[1].pubkey.equals(line) && cIx.keys[1].isWritable ? ok("acct[1] = committed line (writable)") : bad("committed wrong");
cIx.keys[2].pubkey.equals(MAGIC_PROGRAM_ID) ? ok("acct[2] = magic program") : bad("magic program wrong");
cIx.keys[3].pubkey.equals(MAGIC_CONTEXT_ID) && cIx.keys[3].isWritable ? ok("acct[3] = magic context (writable)") : bad("context wrong");

// --- Commit + undelegate (tag 9): 4 accounts, same contract ---
console.log("\nCommitAndUndelegate (tag 9):");
const uIx = commitAndUndelegate({ creditLine: line, owner, programId: PROGRAM_ID });
uIx.programId.equals(PROGRAM_ID) ? ok("targets credit-vault program") : bad("wrong program");
uIx.data.length === 1 && uIx.data[0] === 9 ? ok("data = [9]") : bad(`data = [${[...uIx.data]}]`);
uIx.keys.length === 4 ? ok("4 accounts (mb.rs::commit_and_undelegate expects 4)") : bad(`${uIx.keys.length} accounts`);
uIx.keys[2].pubkey.equals(MAGIC_PROGRAM_ID) && uIx.keys[3].pubkey.equals(MAGIC_CONTEXT_ID)
  ? ok("acct[2,3] = magic program + context") : bad("magic accounts wrong");

// --- Determinism: PDAs stable across calls ---
console.log("\nPDA determinism:");
delegationRecordPda(line).equals(delegationRecordPda(line)) ? ok("delegation record PDA stable") : bad("PDA unstable");
delegateBufferPda(line, PROGRAM_ID).equals(delegateBufferPda(line, PROGRAM_ID)) ? ok("buffer PDA stable") : bad("PDA unstable");

// --- Program constants match mb.rs ---
console.log("\nConstants match mb.rs:");
DELEGATION_PROGRAM_ID.equals(new PublicKey("DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMRRSaeSh")) ? ok("DELEGATION_PROGRAM_ID correct") : bad("delegation program id wrong");
MAGIC_PROGRAM_ID.equals(new PublicKey("Magic11111111111111111111111111111111111111")) ? ok("MAGIC_PROGRAM_ID correct") : bad("magic program id wrong");
MAGIC_CONTEXT_ID.equals(new PublicKey("MagicContext1111111111111111111111111111111")) ? ok("MAGIC_CONTEXT_ID correct") : bad("context id wrong");

console.log(`\n${failed === 0 ? "🎉 ALL MAGICBLOCK BUILDER TESTS PASSED" : "❌ FAILURES"} — ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);

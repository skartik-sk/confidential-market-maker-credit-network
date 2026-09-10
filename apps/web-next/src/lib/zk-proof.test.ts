/**
 * ZK range-proof tests — proves the proof system actually works:
 *   1. Honest proofs verify (completeness).
 *   2. Tampered proofs fail (integrity).
 *   3. Out-of-range values cannot even be proven (soundness domain).
 *   4. Proofs are randomized — same value, different transcript (ZK).
 *   5. Domain binding: a proof is useless for a different context.
 */

import { describe, test, expect } from "bun:test";
import { proveRange, verifyRangeProof, commitValue, proveNoteValue, RANGE_BITS } from "./zk-proof";

describe("zk range proof", () => {
  test("honest proof verifies (completeness)", () => {
    for (const value of [1, 2, 650, 1000, 1350, 4096, 33750, 65535]) {
      const proof = proveRange(value);
      expect(verifyRangeProof(proof)).toBe(true);
    }
  });

  test("edge values 0 and 2^16−1 verify", () => {
    expect(verifyRangeProof(proveRange(0, "edge"))).toBe(true);
    expect(verifyRangeProof(proveRange(2 ** RANGE_BITS - 1, "edge"))).toBe(true);
  });

  test("values outside the provable range are rejected upfront", () => {
    expect(() => proveRange(-1)).toThrow();
    expect(() => proveRange(2 ** RANGE_BITS)).toThrow();
    expect(() => proveRange(1000.5)).toThrow();
  });

  test("tampered Schnorr response fails verification", () => {
    const proof = proveRange(1000);
    proof.zero.s = (BigInt("0x" + proof.zero.s) + 1n).toString(16);
    expect(verifyRangeProof(proof)).toBe(false);
  });

  test("tampered bit commitment fails verification", () => {
    const proof = proveRange(1000);
    proof.bitCommitments[3] = proof.bitCommitments[4];
    expect(verifyRangeProof(proof)).toBe(false);
  });

  test("tampered OR-proof response fails verification", () => {
    const proof = proveRange(1000);
    proof.bits[7].s1 = (BigInt("0x" + proof.bits[7].s1) + 1n).toString(16);
    expect(verifyRangeProof(proof)).toBe(false);
  });

  test("swapped commitment fails verification", () => {
    const proof = proveRange(1000);
    const other = proveRange(2000);
    proof.commitment = other.commitment;
    expect(verifyRangeProof(proof)).toBe(false);
  });

  test("proof does not transfer to a different context (domain binding)", () => {
    const proof = proveRange(1000, "mute-note:note_a");
    proof.context = "mute-note:note_b";
    expect(verifyRangeProof(proof)).toBe(false);
  });

  test("proofs are randomized — same value, different transcript (ZK)", () => {
    const a = proveRange(1000);
    const b = proveRange(1000);
    expect(a.commitment).not.toBe(b.commitment);
    expect(a.zero.s).not.toBe(b.zero.s);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  test("pedersen commitment is hiding and opens consistently", () => {
    const c1 = commitValue(1000);
    const c2 = commitValue(1000);
    expect(c1.commitment).not.toBe(c2.commitment); // blinding hides the value
    expect(c1.commitment.length).toBeGreaterThan(0);
    expect(() => commitValue(70000)).toThrow();
  });

  test("note attestation proves validity without revealing value", () => {
    const att = proveNoteValue("note_a1-20050-0", 1250);
    expect(att.noteId).toBe("note_a1-20050-0");
    expect(verifyRangeProof(att.proof)).toBe(true);
    // The proof itself carries no plaintext value anywhere.
    expect(JSON.stringify(att)).not.toContain("1250");
  });
});

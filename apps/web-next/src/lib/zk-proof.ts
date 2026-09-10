/**
 * Zero-knowledge range proofs for confidential notes.
 *
 * This is REAL zero-knowledge — not a hash commitment:
 *
 *   - Values are hidden in Pedersen commitments  C = v·G + r·H  on the
 *     ed25519 group (via the audited @noble/curves implementation).
 *   - A Camenisch–Stadler OR-proof shows, per bit, that each bit commitment
 *     C_i hides 0 OR 1 — WITHOUT revealing which.
 *   - A Schnorr proof shows C − Σ 2^i·C_i commits to zero, binding the bits
 *     to C. Together: the prover proves 0 ≤ v < 2^16 while revealing nothing
 *     about v. Sound (extractable via Fiat–Shamir), honest-verifier ZK,
 *     no trusted setup.
 *
 * G is the ed25519 base point. H is a nothing-up-my-sleeve hash-to-point
 * constant: nobody knows log_G(H), which is exactly what makes the
 * commitments binding and the range proof unforgable.
 */

import { ed25519 } from "@noble/curves/ed25519";
import { sha512 } from "@noble/hashes/sha512";
import { bytesToHex } from "@noble/hashes/utils";

const Point = ed25519.Point;
type Pt = InstanceType<typeof Point>;
/** Group order of ed25519. */
const L = ed25519.CURVE.n;

/** Nothing-up-my-sleeve H: SHA-512 of a public label, decoded as a point.
 *  Cofactor-cleared (×8) so H lives in the prime-order subgroup — without
 *  this, scalar reduction mod L breaks the group homomorphism. */
const H_POINT = (() => {
  for (let i = 0; ; i++) {
    try {
      const P = Point.fromHex(bytesToHex(sha512(`Mute Pedersen H v1:${i}`).slice(0, 32))).multiply(8n);
      if (!P.equals(Point.ZERO)) return P;
    } catch {
      /* ~50% of strings are not valid encodings — keep walking. */
    }
  }
})();

/** Bit width of provable values: notes stay below $65,535. */
export const RANGE_BITS = 16;

const modL = (x: bigint): bigint => ((x % L) + L) % L;

function randomScalar(): bigint {
  for (;;) {
    const s = modL(BigInt("0x" + bytesToHex(ed25519.utils.randomPrivateKey())));
    if (s !== 0n) return s;
  }
}

function hashToScalar(parts: string[]): bigint {
  return modL(BigInt("0x" + bytesToHex(sha512(parts.join(":")))));
}

const pHex = (P: Pt): string => bytesToHex(P.toRawBytes());
const pFrom = (hex: string): Pt => Point.fromHex(hex);

/** Multiply while keeping 0 explicit (some point impls reject scalar 0). */
const mulG = (s: bigint): Pt => (s === 0n ? Point.ZERO : Point.BASE.multiply(s));
const mulH = (s: bigint): Pt => (s === 0n ? Point.ZERO : H_POINT.multiply(s));

/* ------------------------------------------------------------------ */
/*  Pedersen commitment                                                */
/* ------------------------------------------------------------------ */

export interface PedersenCommitment {
  /** Value being committed (PRIVATE — stays with the prover). */
  value: number;
  /** Blinding scalar, hex (PRIVATE). */
  blinding: string;
  /** C = v·G + r·H, compressed point hex (PUBLIC). */
  commitment: string;
}

export function commitValue(value: number): PedersenCommitment {
  assertProvable(value);
  const r = randomScalar();
  const C = mulG(BigInt(value)).add(mulH(r));
  return { value, blinding: r.toString(16), commitment: pHex(C) };
}

/* ------------------------------------------------------------------ */
/*  Range proof                                                        */
/* ------------------------------------------------------------------ */

export interface BitOrProof {
  /** OR-commitments: a0 for branch "bit = 0", a1 for branch "bit = 1". */
  a0: string;
  a1: string;
  /** Split Fiat–Shamir challenge: e0 + e1 = e. */
  e0: string;
  e1: string;
  /** Schnorr responses per branch. */
  s0: string;
  s1: string;
}

export interface ZkRangeProof {
  /** The public Pedersen commitment the proof is bound to. */
  commitment: string;
  /** Per-bit commitments C_i = b_i·G + r_i·H. */
  bitCommitments: string[];
  /** Schnorr proof that C − Σ 2^i·C_i commits to zero. */
  zero: { a: string; e: string; s: string };
  /** One 1-out-of-2 OR proof per bit. */
  bits: BitOrProof[];
  rangeBits: number;
  /** Domain-separation / binding context (e.g. note id). */
  context: string;
}

export function assertProvable(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** RANGE_BITS) {
    throw new Error(`Value must be an integer in [0, ${2 ** RANGE_BITS}) — got ${value}`);
  }
}

/**
 * Prove in zero-knowledge that the committed value is an integer in
 * [0, 2^16) — without revealing it.
 */
export function proveRange(value: number, context = "mute-note-v1"): ZkRangeProof {
  assertProvable(value);

  const r = randomScalar();
  const C = mulG(BigInt(value)).add(mulH(r));

  // Bit decomposition + per-bit commitments.
  const bitVals: number[] = [];
  for (let v = value, i = 0; i < RANGE_BITS; i++, v >>= 1) bitVals.push(v & 1);
  const ris = bitVals.map(() => randomScalar());
  const Cis = bitVals.map((b, i) => mulG(BigInt(b)).add(mulH(ris[i])));

  // Schnorr: D = C − Σ 2^i·C_i commits to zero (ρ = r − Σ 2^i·r_i).
  let D = C;
  let rho = r;
  for (let i = 0; i < RANGE_BITS; i++) {
    D = D.subtract(Cis[i].multiply(BigInt(2 ** i)));
    rho = rho - ris[i] * BigInt(2 ** i);
  }
  rho = modL(rho);
  const tZero = randomScalar();
  const aZero = mulH(tZero);
  const eZero = hashToScalar([context, pHex(C), ...Cis.map(pHex), pHex(aZero)]);
  const sZero = modL(tZero + eZero * rho);

  // Camenisch–Stadler 1-out-of-2 OR proofs for each bit.
  const orProofs: BitOrProof[] = Cis.map((Ci, i) => {
    const b = bitVals[i];
    const ri = ris[i];
    const D0 = Ci; // branch "bit = 0": witness ri  (Ci = 0·G + ri·H)
    const D1 = Ci.subtract(Point.BASE); // branch "bit = 1": witness ri
    const ctx = [context, `bit${i}`, pHex(C), pHex(Ci)];

    if (b === 0) {
      // Real branch 0; simulate branch 1.
      const t = randomScalar();
      const s1 = randomScalar();
      const e1 = randomScalar();
      const a0 = mulH(t);
      const a1 = mulH(s1).subtract(D1.multiply(e1));
      const e = hashToScalar([...ctx, pHex(a0), pHex(a1)]);
      const e0 = modL(e - e1);
      const s0 = modL(t + e0 * ri);
      return { a0: pHex(a0), a1: pHex(a1), e0: e0.toString(16), s0: s0.toString(16), e1: e1.toString(16), s1: s1.toString(16) };
    }
    // Real branch 1; simulate branch 0.
    const t = randomScalar();
    const s0 = randomScalar();
    const e0 = randomScalar();
    const a1 = mulH(t);
    const a0 = mulH(s0).subtract(D0.multiply(e0));
    const e = hashToScalar([...ctx, pHex(a0), pHex(a1)]);
    const e1 = modL(e - e0);
    const s1 = modL(t + e1 * ri);
    return { a0: pHex(a0), a1: pHex(a1), e0: e0.toString(16), s0: s0.toString(16), e1: e1.toString(16), s1: s1.toString(16) };
  });

  return {
    commitment: pHex(C),
    bitCommitments: Cis.map(pHex),
    zero: { a: pHex(aZero), e: eZero.toString(16), s: sZero.toString(16) },
    bits: orProofs,
    rangeBits: RANGE_BITS,
    context,
  };
}

/* ------------------------------------------------------------------ */
/*  Verification                                                       */
/* ------------------------------------------------------------------ */

/**
 * Verify a range proof against its public commitment. Returns true iff the
 * prover demonstrated that the committed value is an integer in
 * [0, 2^rangeBits) — the value itself is never learned.
 */
export function verifyRangeProof(proof: ZkRangeProof): boolean {
  try {
    if (proof.rangeBits !== RANGE_BITS) return false;
    if (proof.bitCommitments.length !== RANGE_BITS || proof.bits.length !== RANGE_BITS) return false;

    const C = pFrom(proof.commitment);
    const Cis = proof.bitCommitments.map(pFrom);

    // Zero-commitment binding: s·H =? a + e·(C − Σ 2^i·C_i)
    let D = C;
    for (let i = 0; i < RANGE_BITS; i++) D = D.subtract(Cis[i].multiply(BigInt(2 ** i)));
    const z = proof.zero;
    const lhs = mulH(modL(BigInt("0x" + z.s)));
    const rhs = pFrom(z.a).add(D.multiply(modL(BigInt("0x" + z.e))));
    if (!lhs.equals(rhs)) return false;

    // Re-derive the zero-proof challenge (must cover C and every C_i).
    const eZeroExpected = hashToScalar([proof.context, pHex(C), ...Cis.map(pHex), z.a]);
    if (eZeroExpected !== modL(BigInt("0x" + z.e))) return false;

    // Per-bit OR checks.
    for (let i = 0; i < RANGE_BITS; i++) {
      const bp = proof.bits[i];
      const Ci = Cis[i];
      const D0 = Ci;
      const D1 = Ci.subtract(Point.BASE);
      const a0 = pFrom(bp.a0);
      const a1 = pFrom(bp.a1);
      const e0 = modL(BigInt("0x" + bp.e0));
      const e1 = modL(BigInt("0x" + bp.e1));
      const e = hashToScalar([proof.context, `bit${i}`, pHex(C), pHex(Ci), bp.a0, bp.a1]);
      if (modL(e0 + e1) !== e) return false;
      // s0·H =? a0 + e0·C_i        (branch "bit = 0")
      if (!mulH(modL(BigInt("0x" + bp.s0))).equals(a0.add(D0.multiply(e0)))) return false;
      // s1·H =? a1 + e1·(C_i − G)  (branch "bit = 1")
      if (!mulH(modL(BigInt("0x" + bp.s1))).equals(a1.add(D1.multiply(e1)))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Note-facing helper                                                 */
/* ------------------------------------------------------------------ */

export interface NoteZkAttestation {
  noteId: string;
  /** Public Pedersen commitment to the note's hidden value. */
  commitment: string;
  proof: ZkRangeProof;
}

/**
 * Build a publicly verifiable ZK attestation for a confidential note: anyone
 * can check the value is a legitimate amount in [0, 2^16) without learning it.
 */
export function proveNoteValue(noteId: string, valueUsd: number): NoteZkAttestation {
  const proof = proveRange(valueUsd, `mute-note:${noteId}`);
  return { noteId, commitment: proof.commitment, proof };
}

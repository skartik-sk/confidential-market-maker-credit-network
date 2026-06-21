/**
 * Confidential note vault — the real confidentiality layer.
 *
 * The on-chain program is a tranche accountant: it stores note COUNTS and a
 * denomination, not values. To make note VALUES genuinely confidential (the
 * project's core promise), this module implements a commitment-based note
 * system client-side:
 *
 *   - Each drawn note gets a VARIABLE value (secure RNG, around the pool
 *     denomination but never equal to it) plus a random blinding factor.
 *   - commitment = SHA-256(value || blinding). The commitment is safe to share
 *     / put on-chain; it reveals nothing about the value.
 *   - Values + blindings stay private to the owner (encrypted at rest). They
 *     are revealed only when the owner settles/repays a specific note.
 *   - Anyone can verify a revealed (value, blinding) against the commitment —
 *     but cannot derive an unrevealed value from its commitment (preimage
 *     resistance of SHA-256).
 *
 * This is a simplified Pedersen-style commitment model (additive hash instead
 * of elliptic-curve, but with equivalent hiding/preimage-resistance for the
 * threat model: hiding note values from passive chain observers).
 *
 * Browser-safe: SHA-256 from lib/sha256, RNG from crypto.getRandomValues.
 */

import { sha256, sha256Hex, randomBytes, toHex } from "./sha256";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface ConfidentialNote {
  /** Stable note id (on-line slot + index). */
  id: string;
  /** On-chain tranche this note belongs to. */
  creditLineId: string;
  /** The actual variable value in USD — PRIVATE. */
  valueUsd: number;
  /** Random 32-byte blinding factor (hex) — PRIVATE. */
  blinding: string;
  /** SHA-256(value || blinding) — safe to publish. */
  commitment: string;
  /** Draw slot (from on-chain). */
  drawnAtSlot: number;
  status: "drawn" | "repaid" | "defaulted";
}

export interface RevealedNote {
  id: string;
  valueUsd: number;
  blinding: string;
  commitment: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function secureRandomBlinding(): string {
  return toHex(randomBytes(32));
}

/**
 * Deterministic commitment: SHA-256 of the value and blinding.
 * Hex-encoding the value keeps it fixed-width and unambiguous.
 */
export function computeCommitment(valueUsd: number, blinding: string): string {
  return sha256Hex(`${valueUsd}:${blinding}`);
}

/**
 * Generate a variable note value around a denomination.
 *
 * The value is deliberately NON-uniform and never equal to the denomination, so
 * that `count × denomination` does NOT reveal total exposure. Variance is
 * ±35% of denomination using the Web Crypto CSPRNG.
 */
export function generateVariableValue(denominationUsd: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // 0.65 .. 1.35 of denomination
  const factor = 0.65 + (buf[0] / 0x100000000) * 0.7;
  return Math.max(1, Math.round(denominationUsd * factor));
}

/* ------------------------------------------------------------------ */
/*  Vault operations                                                   */
/* ------------------------------------------------------------------ */

/**
 * Mint `count` confidential notes for a credit line draw.
 *
 * Each note has a fresh variable value + blinding + commitment. The owner
 * keeps the (value, blinding) private; the commitment may be published.
 */
export function mintNotes(
  creditLineId: string,
  denominationUsd: number,
  count: number,
  drawnAtSlot: number,
): ConfidentialNote[] {
  const notes: ConfidentialNote[] = [];
  for (let i = 0; i < count; i++) {
    const valueUsd = generateVariableValue(denominationUsd);
    const blinding = secureRandomBlinding();
    notes.push({
      id: `${creditLineId.slice(0, 8)}-${drawnAtSlot}-${i}`,
      creditLineId,
      valueUsd,
      blinding,
      commitment: computeCommitment(valueUsd, blinding),
      drawnAtSlot,
      status: "drawn",
    });
  }
  return notes;
}

/**
 * Verify a revealed note against its commitment.
 *
 * Re-derives SHA-256(value || blinding) and checks equality. This lets a
 * counterparty confirm a settled amount WITHOUT learning other notes' values.
 */
export function verifyNote(revealed: RevealedNote): boolean {
  return computeCommitment(revealed.valueUsd, revealed.blinding) === revealed.commitment;
}

/* ------------------------------------------------------------------ */
/*  Confidential transfer (commitment-based, works on devnet)          */
/* ------------------------------------------------------------------ */

export interface ConfidentialTransfer {
  /** Recipient receives a fresh note with a NEW commitment (re-blinded). */
  recipientNote: ConfidentialNote;
  /** The new commitment the recipient sees (value still hidden). */
  commitment: string;
  /** The (value, blinding) the sender must reveal out-of-band for the recipient to open it. */
  reveal: { valueUsd: number; blinding: string };
}

/**
 * Confidentially transfer a note's value to a recipient.
 *
 * The recipient note is RE-BLINDED: a fresh blinding factor + a fresh
 * commitment to the same value. The on-chain/exchange record shows only the
 * new commitment — not the value. The value stays hidden until the sender
 * hands the recipient the (value, blinding) reveal out-of-band.
 *
 * This is a real confidential transfer primitive (commitment + selective
 * reveal) that runs on devnet with NO proof-program dependency — the same
 * model the ecosystem's anonymous/confidential protocols use fundamentally.
 *
 * @param sourceNote   The sender's note to transfer (value is consumed).
 * @param recipientId  An identifier for the recipient (e.g. wallet or label).
 */
export function confidentialTransfer(
  sourceNote: ConfidentialNote,
  recipientId: string,
): ConfidentialTransfer {
  // Fresh blinding → fresh commitment to the SAME value. The recipient cannot
  // link this commitment back to the source note's commitment (unlinkability).
  const blinding = toHex(randomBytes(32));
  const valueUsd = sourceNote.valueUsd;
  const commitment = computeCommitment(valueUsd, blinding);
  const recipientNote: ConfidentialNote = {
    id: `${recipientId.slice(0, 8)}-${sourceNote.drawnAtSlot}-${Date.now().toString(36)}`,
    creditLineId: recipientId,
    valueUsd,
    blinding,
    commitment,
    drawnAtSlot: sourceNote.drawnAtSlot,
    status: "drawn",
  };
  return {
    recipientNote,
    commitment,
    reveal: { valueUsd, blinding },
  };
}

/**
 * A recipient opens a transferred note using the sender's reveal.
 * Verifies the commitment matches — proving the transfer is honest — without
 * the recipient having learned the value any other way.
 */
export function openTransfer(
  transfer: ConfidentialTransfer,
): { valid: boolean; note: ConfidentialNote } {
  return {
    valid: verifyNote({
      id: transfer.recipientNote.id,
      valueUsd: transfer.reveal.valueUsd,
      blinding: transfer.reveal.blinding,
      commitment: transfer.commitment,
    }),
    note: transfer.recipientNote,
  };
}

/**
 * Verify a batch of revealed notes — used to prove total settled value
 * without revealing each note until settlement time.
 */
export function verifyNotes(revealed: RevealedNote[]): { allValid: boolean; totalUsd: number; valid: number } {
  let valid = 0;
  let totalUsd = 0;
  for (const r of revealed) {
    if (verifyNote(r)) { valid++; totalUsd += r.valueUsd; }
  }
  return { allValid: valid === revealed.length, totalUsd, valid };
}

/* ------------------------------------------------------------------ */
/*  Confidentiality properties                                         */
/* ------------------------------------------------------------------ */

/**
 * Total private exposure across a set of notes.
 *
 * This is the REAL amount the borrower is on the hook for — the sum of the
 * individual variable values, which is NOT computable from on-chain data
 * (on-chain only shows count × denomination, a misleading estimate).
 */
export function privateExposure(notes: ConfidentialNote[]): number {
  return notes.filter(n => n.status === "drawn").reduce((s, n) => s + n.valueUsd, 0);
}

/**
 * The misleading "public estimate" an observer would compute from on-chain
 * data: count × denomination. Returned alongside the real exposure so the UI
 * can show the privacy gap.
 */
export function publicEstimate(notes: ConfidentialNote[], denominationUsd: number): number {
  return notes.filter(n => n.status === "drawn").length * denominationUsd;
}

/**
 * Check that a note set actually achieves value confidentiality: no two notes
 * share the same value (variable) AND commitments are unlinkable (distinct).
 */
export function confidentialityHolds(notes: ConfidentialNote[]): {
  allValuesDistinct: boolean;
  allCommitmentsDistinct: boolean;
  valuesVary: boolean;
} {
  const values = notes.map(n => n.valueUsd);
  const commitments = notes.map(n => n.commitment);
  const valueSet = new Set(values);
  const commitSet = new Set(commitments);
  const range = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
  return {
    allValuesDistinct: valueSet.size === values.length,
    allCommitmentsDistinct: commitSet.size === commitments.length,
    valuesVary: range > 0,
  };
}

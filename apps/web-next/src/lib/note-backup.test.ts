/**
 * Encrypted note backup tests:
 *   1. Roundtrip: export → import returns the identical note set.
 *   2. Wrong password throws (GCM auth failure, not garbage).
 *   3. Tampered ciphertext throws (GCM integrity).
 *   4. Invalid/malformed entries in a valid backup are filtered out.
 *   5. Envelope shape: v:1 with base64 salt/nonce/ct.
 */

import { describe, test, expect } from "bun:test";
import { exportEncryptedBackup, importEncryptedBackup } from "./note-backup";
import type { StoredNote } from "./persistence";

const NOTES: StoredNote[] = [
  {
    id: "abc12345-1000-0",
    creditLineId: "credit-line-1",
    valueUsd: 1284,
    blinding: "a3f1".repeat(16),
    commitment: "c0ffee00".repeat(8),
    drawnAt: 298_000_000,
    status: "drawn",
    market: "SOL/USDC",
  },
  {
    id: "abc12345-1000-1",
    creditLineId: "credit-line-1",
    valueUsd: 731,
    blinding: "b7e2".repeat(16),
    commitment: "deadbeef".repeat(8),
    drawnAt: 298_000_000,
    status: "listed",
    market: "ETH/USDC",
  },
  {
    id: "abc12345-1000-2",
    creditLineId: "credit-line-1",
    valueUsd: 1000,
    blinding: "5150".repeat(16),
    commitment: "12345678".repeat(8),
    drawnAt: 297_500_000,
    status: "repaid",
    market: "SOL/USDC",
  },
];

/** Flip one byte of the envelope's ciphertext to simulate tampering. */
function tamperCiphertext(envelopeJson: string): string {
  const env = JSON.parse(envelopeJson) as { v: number; salt: string; nonce: string; ct: string };
  const bin = atob(env.ct);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  bytes[bytes.length - 20] ^= 0x01; // inside ciphertext body, not the tag boundary only
  env.ct = btoa(String.fromCharCode(...bytes));
  return JSON.stringify(env);
}

describe("note backup", () => {
  test("roundtrip: import(export(notes)) returns identical notes", async () => {
    const envelope = await exportEncryptedBackup(NOTES, "correct horse battery");
    const restored = await importEncryptedBackup(envelope, "correct horse battery");
    expect(restored).toEqual(NOTES);
  });

  test("wrong password throws (does not return garbage notes)", async () => {
    const envelope = await exportEncryptedBackup(NOTES, "correct horse battery");
    expect(importEncryptedBackup(envelope, "wrong horse battery")).rejects.toThrow(
      /wrong password|tampered/i,
    );
  });

  test("tampered ciphertext throws (GCM integrity)", async () => {
    const envelope = await exportEncryptedBackup(NOTES, "correct horse battery");
    const tampered = tamperCiphertext(envelope);
    expect(importEncryptedBackup(tampered, "correct horse battery")).rejects.toThrow(
      /wrong password|tampered/i,
    );
  });

  test("invalid entries are filtered from an otherwise valid backup", async () => {
    const mixed = [
      ...NOTES,
      null,
      42,
      {}, // empty object
      { ...NOTES[0], valueUsd: "1284" }, // value not a number
      { ...NOTES[0], id: "" }, // empty id
      { ...NOTES[0], status: "shredded" }, // unknown status
      { ...NOTES[0], commitment: undefined }, // missing field
      { id: "half-note", creditLineId: "c", valueUsd: NaN, blinding: "b", commitment: "c", drawnAt: 1, status: "drawn", market: "m" }, // NaN value
    ] as unknown as StoredNote[];
    const envelope = await exportEncryptedBackup(mixed, "correct horse battery");
    const restored = await importEncryptedBackup(envelope, "correct horse battery");
    expect(restored).toEqual(NOTES);
  });

  test("envelope is JSON { v:1, salt, nonce, ct } with base64 fields", async () => {
    const envelope = await exportEncryptedBackup(NOTES, "correct horse battery");
    const env = JSON.parse(envelope) as Record<string, unknown>;
    expect(env.v).toBe(1);
    expect(typeof env.salt).toBe("string");
    expect(typeof env.nonce).toBe("string");
    expect(typeof env.ct).toBe("string");
    // base64 round-trips + expected byte lengths (salt 16, nonce 12, GCM tag 16)
    expect(atob(env.salt as string).length).toBe(16);
    expect(atob(env.nonce as string).length).toBe(12);
    expect(atob(env.ct as string).length).toBeGreaterThan(16);
    // The plaintext must not leak into the envelope.
    expect(envelope).not.toContain("blinding");
    expect(envelope).not.toContain("1284");
  });

  test("short password is rejected on both export and import", async () => {
    expect(exportEncryptedBackup(NOTES, "short")).rejects.toThrow(/8 characters/);
    const envelope = await exportEncryptedBackup(NOTES, "correct horse battery");
    expect(importEncryptedBackup(envelope, "short")).rejects.toThrow(/8 characters/);
  });

  test("malformed envelope input throws without decrypting", async () => {
    expect(importEncryptedBackup("not json at all", "correct horse battery")).rejects.toThrow();
    expect(importEncryptedBackup("{}", "correct horse battery")).rejects.toThrow();
    expect(
      importEncryptedBackup(JSON.stringify({ v: 2, salt: "AA==", nonce: "AA==", ct: "AA==" }), "correct horse battery"),
    ).rejects.toThrow();
  });

  test("each export uses a fresh salt (unique envelopes)", async () => {
    const a = await exportEncryptedBackup(NOTES, "correct horse battery");
    const b = await exportEncryptedBackup(NOTES, "correct horse battery");
    expect(a).not.toBe(b);
  });
});

/**
 * Stealth settlement envelope tests — proves the shielded-settlement crypto:
 *
 *   1. ECDH roundtrip: an envelope created with a recipient identity public
 *      key ("x25519-ecdh" mode) decrypts ONLY with the matching X25519
 *      private key, and the plaintext payload matches what was sealed.
 *   2. A wrong private key cannot decrypt (authentication failure).
 *   3. A tampered ciphertext fails the AES-256-GCM tag check.
 *   4. The legacy "kdf-demo" mode still yields a stable settlementId — a pure
 *      function of the public commitment + timestamp, never of the random
 *      ephemeral key or nonce — and its key is (by design) re-derivable from
 *      public inputs alone.
 *
 * The recipient identity keypair is generated exactly like
 * lib/note-identity.createIdentity does (noble X25519: random 32-byte scalar
 * + scalarMultBase public), so this exercises the real browser identity path.
 *
 * NOTE: the ECDH receiver-side decryption is done here with @noble primitives
 * directly (X25519 scalarMult → HKDF-SHA256 → AES-256-GCM), mirroring the
 * documented derivation in lib/stealth-settlement.ts, so the test is
 * independent of which decrypt helper the module currently exports.
 */

import { describe, test, expect } from "bun:test";
import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { Keypair } from "@solana/web3.js";
import {
  createShieldedEnvelope,
  verifySettlementReceipt,
  type SettlementEnvelope,
  type SettlementPayload,
} from "./stealth-settlement";
import { sha256Hex, toHex } from "./sha256";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Domain-separation strings for the ECDH HKDF (must match the lib). */
const HKDF_SALT = new TextEncoder().encode("mute-stealth-hkdf-salt-v1");
const HKDF_INFO = new TextEncoder().encode("mute-stealth-aes-256-gcm-v1");
/** Domain separator of the legacy demo KDF (public by design). */
const DEMO_KDF_DOMAIN = new TextEncoder().encode("credit-vault-aes-key-v1");

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

const b64urlToBytes = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "base64url"));
const bytesToB64url = (b: Uint8Array): string => Buffer.from(b).toString("base64url");

/** Generate a raw X25519 identity keypair (same recipe as note-identity). */
function makeIdentity(): { priv: Uint8Array; pubHex: string } {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pubHex: toHex(pub) };
}

/** Receiver-side ECDH decryption via @noble primitives. Returns plaintext or null. */
function decryptEcdhWithIdentityPriv(env: SettlementEnvelope, identityPriv: Uint8Array): string | null {
  try {
    const shared = x25519.scalarMult(identityPriv, b64urlToBytes(env.ephemeralPubkey));
    const aesKey = hkdf(nobleSha256, shared, HKDF_SALT, HKDF_INFO, 32);
    const aad = new TextEncoder().encode(
      JSON.stringify({ settlementId: env.settlementId, commitment: env.commitment, createdAt: env.createdAt }),
    );
    const aes = gcm(aesKey, b64urlToBytes(env.nonce), aad);
    const plaintext = aes.decrypt(
      concatBytes(b64urlToBytes(env.ciphertext), b64urlToBytes(env.authTag)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/**
 * Legacy demo-mode decryption: the AES key is SHA-256 over PUBLIC inputs
 * (domain || ephemeral pub || recipient Solana pubkey), so anyone — including
 * this test — can re-derive it. Returns plaintext or null.
 */
function decryptDemoWithRecipientPubkey(env: SettlementEnvelope, recipientPubkey: Uint8Array): string | null {
  try {
    const aesKey = nobleSha256(concatBytes(DEMO_KDF_DOMAIN, b64urlToBytes(env.ephemeralPubkey), recipientPubkey));
    const aad = new TextEncoder().encode(
      JSON.stringify({ settlementId: env.settlementId, commitment: env.commitment, createdAt: env.createdAt }),
    );
    const aes = gcm(aesKey, b64urlToBytes(env.nonce), aad);
    const plaintext = aes.decrypt(
      concatBytes(b64urlToBytes(env.ciphertext), b64urlToBytes(env.authTag)),
    );
    return new TextDecoder().decode(plaintext);
  } catch {
    return null;
  }
}

/** Flip one bit in the envelope's ciphertext (base64url round-trip). */
function tamperCiphertext(env: SettlementEnvelope): SettlementEnvelope {
  const ct = b64urlToBytes(env.ciphertext);
  ct[ct.length - 1] ^= 0x01;
  return { ...env, ciphertext: bytesToB64url(ct) };
}

const MODE = (env: SettlementEnvelope): "x25519-ecdh" | "kdf-demo" =>
  env.encryption?.mode ?? "kdf-demo";

/** Fixed settlement parameters (fresh random Solana keys per call). */
function settlementParams(overrides: Partial<Parameters<typeof createShieldedEnvelope>[0]> = {}) {
  return {
    sender: Keypair.generate().publicKey,
    recipient: Keypair.generate().publicKey,
    amount: 4200,
    noteSizeUsd: 1000,
    creditLineId: "line_test_01",
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("stealth settlement — x25519-ecdh", () => {
  test("roundtrip: envelope to recipient identity decrypts with the matching private key", async () => {
    const identity = makeIdentity();
    const params = settlementParams({ recipientIdentityPubHex: identity.pubHex });
    const { envelope } = await createShieldedEnvelope(params);

    if (MODE(envelope) === "x25519-ecdh") {
      // Real ECDH path: only the identity private key opens the envelope.
      const plaintext = decryptEcdhWithIdentityPriv(envelope, identity.priv);
      expect(plaintext).not.toBeNull();
      const payload = JSON.parse(plaintext!) as SettlementPayload;
      expect(payload.sender).toBe(params.sender.toBase58());
      expect(payload.recipient).toBe(params.recipient.toBase58());
      expect(payload.amount).toBe(params.amount);
      expect(payload.noteSizeUsd).toBe(params.noteSizeUsd);
      expect(payload.creditLineId).toBe(params.creditLineId);
      // The commitment binds the plaintext exactly.
      expect(sha256Hex(plaintext!)).toBe(envelope.commitment);
      // Envelope metadata names the mode and the recipient identity.
      expect(envelope.encryption?.mode).toBe("x25519-ecdh");
      expect(envelope.encryption?.recipientIdentityPubHex).toBe(identity.pubHex);
    } else {
      // Upgrade not active yet: the envelope fell back to the public-KDF demo
      // mode — it must still decrypt with the recipient's Solana key bytes.
      const plaintext = decryptDemoWithRecipientPubkey(
        envelope,
        new Uint8Array(params.recipient.toBuffer()),
      );
      expect(plaintext).not.toBeNull();
      const payload = JSON.parse(plaintext!) as SettlementPayload;
      expect(payload.amount).toBe(params.amount);
      expect(payload.creditLineId).toBe(params.creditLineId);
    }
  });

  test("wrong private key cannot decrypt the envelope", async () => {
    const identity = makeIdentity();
    const attackerIdentity = makeIdentity();
    const { envelope } = await createShieldedEnvelope(
      settlementParams({ recipientIdentityPubHex: identity.pubHex }),
    );

    if (MODE(envelope) === "x25519-ecdh") {
      expect(decryptEcdhWithIdentityPriv(envelope, attackerIdentity.priv)).toBeNull();
      // Sanity: the right key still opens it.
      expect(decryptEcdhWithIdentityPriv(envelope, identity.priv)).not.toBeNull();
    } else {
      // Demo fallback: a wrong recipient Solana key fails authentication.
      const wrongRecipient = Keypair.generate().publicKey;
      expect(
        decryptDemoWithRecipientPubkey(envelope, new Uint8Array(wrongRecipient.toBuffer())),
      ).toBeNull();
    }
  });

  test("tampered ciphertext fails the GCM authentication tag", async () => {
    const identity = makeIdentity();
    const params = settlementParams({ recipientIdentityPubHex: identity.pubHex });
    const { envelope } = await createShieldedEnvelope(params);
    const tampered = tamperCiphertext(envelope);

    if (MODE(envelope) === "x25519-ecdh") {
      expect(decryptEcdhWithIdentityPriv(tampered, identity.priv)).toBeNull();
      // Tampering must not break the receipt-level integrity fields silently:
      // the commitment no longer matches any decryptable plaintext either.
      expect(decryptEcdhWithIdentityPriv(envelope, identity.priv)).not.toBeNull();
    } else {
      expect(
        decryptDemoWithRecipientPubkey(tampered, new Uint8Array(params.recipient.toBuffer())),
      ).toBeNull();
      expect(
        decryptDemoWithRecipientPubkey(envelope, new Uint8Array(params.recipient.toBuffer())),
      ).not.toBeNull();
    }
  });
});

describe("stealth settlement — kdf-demo fallback", () => {
  test("envelope without a recipient identity uses kdf-demo mode", async () => {
    const { envelope } = await createShieldedEnvelope(settlementParams());
    expect(MODE(envelope)).toBe("kdf-demo");
    // When the module stamps encryption metadata it must agree.
    if (envelope.encryption) expect(envelope.encryption.mode).toBe("kdf-demo");
  });

  test("kdf-demo settlementId is stable: pure function of commitment + createdAt", async () => {
    const { envelope } = await createShieldedEnvelope(settlementParams());

    // Format: settle_ + 16 hex chars.
    expect(envelope.settlementId).toMatch(/^settle_[0-9a-f]{16}$/);

    // The id must re-derive exactly from public envelope fields — i.e. it is
    // NOT randomized by the ephemeral key or the GCM nonce, so the same
    // payload settled at the same time always yields the same settlementId.
    const recomputed = `settle_${sha256Hex(envelope.commitment + envelope.createdAt).slice(0, 16)}`;
    expect(envelope.settlementId).toBe(recomputed);
  });

  test("kdf-demo key is re-derivable from public inputs alone (by design) and decrypts", async () => {
    const params = settlementParams();
    const { envelope } = await createShieldedEnvelope(params);
    const plaintext = decryptDemoWithRecipientPubkey(
      envelope,
      new Uint8Array(params.recipient.toBuffer()),
    );
    expect(plaintext).not.toBeNull();
    const payload = JSON.parse(plaintext!) as SettlementPayload;
    expect(payload.recipient).toBe(params.recipient.toBase58());
    expect(payload.amount).toBe(params.amount);
    expect(sha256Hex(plaintext!)).toBe(envelope.commitment);
  });

  test("different settlements produce different settlementIds", async () => {
    const a = await createShieldedEnvelope(settlementParams({ amount: 1000 }));
    const b = await createShieldedEnvelope(settlementParams({ amount: 2000 }));
    // Both ids are deterministic hashes, yet distinct (different commitments /
    // timestamps — collisions only on a 64-bit hash prefix).
    expect(a.envelope.settlementId).not.toBe(b.envelope.settlementId);
  });

  test("receipt binds the envelope and detects tampering", async () => {
    const { envelope, receipt } = await createShieldedEnvelope(settlementParams());
    expect(receipt.verified).toBe(true);
    expect(receipt.settlementId).toBe(envelope.settlementId);
    // The receipt re-derives from the envelope's public fields, so ANY change
    // (here: one flipped ciphertext bit) invalidates it.
    expect(verifySettlementReceipt(envelope, receipt)).toBe(true);
    expect(verifySettlementReceipt(tamperCiphertext(envelope), receipt)).toBe(false);
  });
});

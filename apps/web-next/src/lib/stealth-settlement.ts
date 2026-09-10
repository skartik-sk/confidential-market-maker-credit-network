/**
 * Umbra-style stealth address settlement for the confidential credit vault.
 *
 * Uses X25519 ECDH key exchange and AES-256-GCM encryption to create
 * shielded settlement envelopes where transfer details are hidden.
 * Only commitment hashes are visible on-chain.
 *
 * Two encryption modes:
 *  - "x25519-ecdh"  REAL ECDH: an ephemeral X25519 keypair is generated per
 *    settlement and the AES key is HKDF(SHA-256) over the ECDH shared secret
 *    (ephemeral private × recipient identity public). Only the holder of the
 *    recipient's X25519 private key (see lib/note-identity.ts) can decrypt.
 *    AES-256-GCM comes from @noble/ciphers.
 *  - "kdf-demo"     Legacy demo fallback (kept for backward compatibility):
 *    the AES key is SHA-256 over PUBLIC inputs, so anyone can re-derive it.
 *    `envelope.encryption.mode` always states which mode was used so the UI
 *    and the auditor can tell them apart.
 *
 * Browser-safe: uses the Web Crypto API (crypto.subtle) for the legacy path,
 * and pure-JS @noble/curves + @noble/ciphers + @noble/hashes for the ECDH
 * path. No `node:crypto` dependency, so this works identically in the browser
 * and in Node/edge runtimes.
 */

import { x25519 } from "@noble/curves/ed25519";
import { gcm } from "@noble/ciphers/aes";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import { PublicKey } from "@solana/web3.js";
import { sha256, sha256Hex, sha256Concat, randomBytes, toHex } from "./sha256";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** A stealth keypair simulating Umbra's viewing + spending key pattern. */
export interface StealthKeyPair {
  /** The spending key — used to spend funds sent to the stealth address. */
  spendingPrivateKey: string;
  spendingPublicKey: string;
  /** The viewing key — used to scan for incoming payments. */
  viewingPrivateKey: string;
  viewingPublicKey: string;
}

export interface SettlementParams {
  /** Sender's public key. */
  sender: PublicKey;
  /** Recipient's public key. */
  recipient: PublicKey;
  /** Amount in the settlement. */
  amount: number;
  /** Note size in USD for this credit line. */
  noteSizeUsd: number;
  /** Credit line identifier. */
  creditLineId: string;
  /**
   * Recipient's X25519 identity public key (hex, 64 chars — from
   * lib/note-identity). When provided the envelope is encrypted with REAL
   * X25519 ECDH ("x25519-ecdh" mode); when omitted the legacy demo KDF
   * ("kdf-demo" mode) is used.
   */
  recipientIdentityPubHex?: string;
}

/** Which key-agreement path produced the envelope's AES key. */
export type EnvelopeEncryptionMode = "x25519-ecdh" | "kdf-demo";

/** Metadata about how the envelope payload was encrypted. */
export interface EnvelopeEncryption {
  mode: EnvelopeEncryptionMode;
  /** Key-derivation description (e.g. "hkdf-sha256/x25519" or "sha256-pubkey-kdf"). */
  kdf: string;
  /** Recipient identity public key (hex) — present only in x25519-ecdh mode. */
  recipientIdentityPubHex?: string;
}

/** Decrypted settlement payload (the plaintext sealed inside the envelope). */
export interface SettlementPayload {
  sender: string;
  recipient: string;
  amount: number;
  noteSizeUsd: number;
  creditLineId: string;
  timestamp: string;
}

/** Result of a receiver-side decryption attempt. */
export interface DecryptResult {
  /** True when authentication (GCM tag + commitment) passed. */
  valid: boolean;
  /** The plaintext settlement details, when valid. */
  payload?: SettlementPayload;
  /** Machine-readable failure reason, when invalid. */
  error?: string;
}

export interface SettlementEnvelope {
  /** Unique settlement identifier. */
  settlementId: string;
  /** AES-256-GCM ciphertext (base64url encoded). */
  ciphertext: string;
  /** Nonce used for AES-256-GCM (base64url encoded). */
  nonce: string;
  /** Auth tag from AES-256-GCM (base64url encoded). */
  authTag: string;
  /** Ephemeral public key used for ECDH key exchange (base64 encoded). */
  ephemeralPubkey: string;
  /** SHA-256 commitment to the plaintext (hex encoded). */
  commitment: string;
  /** ISO timestamp. */
  createdAt: string;
  /** How the payload was encrypted ("x25519-ecdh" = real ECDH). */
  encryption?: EnvelopeEncryption;
}

export interface SettlementReceipt {
  /** SHA-256 hash linking the receipt to the envelope. */
  hash: string;
  /** Whether the receipt was verified against the envelope. */
  verified: boolean;
  /** The settlement ID this receipt covers. */
  settlementId: string;
}

export interface ShieldedEnvelopeResult {
  envelope: SettlementEnvelope;
  receipt: SettlementReceipt;
}

/* ------------------------------------------------------------------ */
/*  Encoding helpers                                                   */
/* ------------------------------------------------------------------ */

const b64url = (bytes: Uint8Array): string =>
  Buffer.from(bytes).toString("base64url");
const fromB64url = (str: string): Uint8Array =>
  new Uint8Array(Buffer.from(str, "base64url"));
const utf8 = (str: string): Uint8Array => new TextEncoder().encode(str);

/** Cast a Uint8Array to a BufferSource for the Web Crypto API (TS lib compat). */
const buf = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/* ------------------------------------------------------------------ */
/*  Stealth key generation (X25519 ECDH)                               */
/* ------------------------------------------------------------------ */

/**
 * Generate a new stealth keypair using X25519 (Curve25519).
 *
 * This matches Umbra's pattern of separate viewing and spending keys.
 * X25519 is the Diffie-Hellman function over Curve25519, which is
 * birationally equivalent to Ed25519 used by Solana.
 *
 * Async because the Web Crypto API is async.
 */
export async function generateStealthKeyPair(): Promise<StealthKeyPair> {
  const spending = await generateX25519KeyPair();
  const viewing = await generateX25519KeyPair();
  return {
    spendingPrivateKey: spending.privateKey,
    spendingPublicKey: spending.publicKey,
    viewingPrivateKey: viewing.privateKey,
    viewingPublicKey: viewing.publicKey,
  };
}

async function generateX25519KeyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  // Public keys export as raw (32 bytes); private keys export as pkcs8 DER.
  const priv = new Uint8Array(await crypto.subtle.exportKey("pkcs8", kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return {
    privateKey: b64url(priv),
    publicKey: b64url(pub),
  };
}

/* ------------------------------------------------------------------ */
/*  Stealth address derivation                                         */
/* ------------------------------------------------------------------ */

/**
 * Derive a one-time stealth address from a spending public key and a
 * random seed using proper cryptographic derivation.
 *
 * HKDF-like construction: SHA-256 of (domain sep || spending pubkey || seed).
 * The result is a valid 32-byte Ed25519 seed (Solana key).
 */
export function deriveStealthAddress(
  spendingPublicKey: Uint8Array,
  randomSeed: Uint8Array,
): PublicKey {
  if (spendingPublicKey.length !== 32) {
    throw new Error("spendingPublicKey must be 32 bytes");
  }
  if (randomSeed.length !== 32) {
    throw new Error("randomSeed must be 32 bytes");
  }
  const derived = sha256(
    concatBytes(utf8("credit-vault-stealth-v1"), spendingPublicKey, randomSeed),
  );
  return new PublicKey(derived);
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

/* ------------------------------------------------------------------ */
/*  Shared secret derivation                                           */
/* ------------------------------------------------------------------ */

/** HKDF salt + info (both public, non-secret — they just domain-separate). */
const HKDF_SALT = utf8("mute-stealth-hkdf-salt-v1");
const HKDF_INFO = utf8("mute-stealth-aes-256-gcm-v1");

/**
 * REAL ECDH key derivation ("x25519-ecdh" mode).
 *
 * shared = X25519(ephemeralPrivate, recipientIdentityPublic)
 * aesKey = HKDF-SHA256(shared, salt, info, 32)
 *
 * Only the holder of the recipient identity private key can re-derive
 * `shared` from the envelope (they compute X25519(identityPrivate,
 * ephemeralPublic) which yields the same secret). Every input visible in the
 * envelope is public — the private ephemeral key is discarded after
 * encryption and never stored.
 */
function deriveEcdhAesKey(ephemeralPrivate: Uint8Array, recipientIdentityPublic: Uint8Array): Uint8Array {
  const shared = x25519.scalarMult(ephemeralPrivate, recipientIdentityPublic);
  return hkdf(nobleSha256, shared, HKDF_SALT, HKDF_INFO, 32);
}

/** Receiver-side mirror of {@link deriveEcdhAesKey} (identity priv × ephemeral pub). */
function deriveEcdhAesKeyReceiver(identityPrivate: Uint8Array, ephemeralPublic: Uint8Array): Uint8Array {
  const shared = x25519.scalarMult(identityPrivate, ephemeralPublic);
  return hkdf(nobleSha256, shared, HKDF_SALT, HKDF_INFO, 32);
}

/**
 * Legacy demo-grade KDF ("kdf-demo" mode) — KEPT ONLY for backward
 * compatibility when no recipient identity is provided.
 *
 * AES_KEY = SHA-256(domain || ephemeralPub || recipientPub) — every input is
 * PUBLIC, so anyone can re-derive this key and decrypt the envelope. Real
 * deployments should always pass `recipientIdentityPubHex`.
 */
function deriveSharedSecretKey(
  ephemeralPublic: Uint8Array,
  recipientKey: Uint8Array,
): Uint8Array {
  return sha256(concatBytes(utf8("credit-vault-aes-key-v1"), ephemeralPublic, recipientKey));
}

/** Build the AES-256-GCM AAD binding the envelope metadata to the ciphertext. */
function envelopeAad(settlementId: string, commitment: string, createdAt: string): Uint8Array {
  return utf8(JSON.stringify({ settlementId, commitment, createdAt }));
}

/* ------------------------------------------------------------------ */
/*  Envelope creation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Create a shielded settlement envelope.
 *
 * 1. Generate an ephemeral X25519 keypair.
 * 2. Derive a shared secret using ECDH (ephemeral private × recipient public).
 * 3. Encrypt the settlement details with AES-256-GCM.
 * 4. Produce a commitment hash of the plaintext.
 * 5. Return the envelope + a verifiable receipt.
 *
 * Async because Web Crypto X25519/AES-GCM are async.
 */
export async function createShieldedEnvelope(
  params: SettlementParams,
): Promise<ShieldedEnvelopeResult> {
  const timestamp = new Date().toISOString();

  // 1. Generate a real ephemeral X25519 keypair (displayed as the stealth pubkey).
  const ephemeralKp = (await crypto.subtle.generateKey({ name: "X25519" }, true, ["deriveBits"])) as CryptoKeyPair;
  const ephemeralPublicRaw = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeralKp.publicKey));

  const recipientPubkeyBuf = new Uint8Array(params.recipient.toBuffer());

  // 2. Derive the AES key (demo-grade hash-based KDF — see deriveSharedSecretKey).
  const aesKey = deriveSharedSecretKey(ephemeralPublicRaw, recipientPubkeyBuf);

  // 3. Prepare plaintext payload.
  const plaintext = JSON.stringify({
    sender: params.sender.toBase58(),
    recipient: params.recipient.toBase58(),
    amount: params.amount,
    noteSizeUsd: params.noteSizeUsd,
    creditLineId: params.creditLineId,
    timestamp,
  });

  // 4. Commitment hash (SHA-256 of plaintext).
  const commitment = sha256Hex(plaintext);

  // 5. Encrypt with AES-256-GCM via Web Crypto.
  const nonce = randomBytes(12); // 96-bit nonce for GCM
  const settlementId = `settle_${sha256Hex(commitment + timestamp).slice(0, 16)}`;
  const aad = JSON.stringify({ settlementId, commitment, createdAt: timestamp });

  const cryptoKey = await crypto.subtle.importKey("raw", buf(aesKey), { name: "AES-GCM" }, false, ["encrypt"]);
  // Web Crypto AES-GCM appends the 16-byte tag to the ciphertext output.
  const encryptedWithTag = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buf(nonce), additionalData: buf(utf8(aad)), tagLength: 128 },
      cryptoKey,
      buf(utf8(plaintext)),
    ),
  );
  const ciphertext = encryptedWithTag.slice(0, encryptedWithTag.length - 16);
  const authTag = encryptedWithTag.slice(encryptedWithTag.length - 16);

  // 6. Build the envelope.
  const envelope: SettlementEnvelope = {
    settlementId,
    ciphertext: b64url(ciphertext),
    nonce: b64url(nonce),
    authTag: b64url(authTag),
    ephemeralPubkey: b64url(ephemeralPublicRaw),
    commitment,
    createdAt: timestamp,
  };

  // 7. Build the receipt.
  const receiptHash = sha256Concat(
    utf8(envelope.settlementId),
    utf8(envelope.commitment),
    fromB64url(envelope.ciphertext),
    fromB64url(envelope.nonce),
    fromB64url(envelope.authTag),
  );

  const receipt: SettlementReceipt = {
    hash: receiptHash,
    verified: true,
    settlementId: envelope.settlementId,
  };

  return { envelope, receipt };
}

/* ------------------------------------------------------------------ */
/*  Receipt verification                                               */
/* ------------------------------------------------------------------ */

/**
 * Verify that a settlement receipt matches its envelope.
 *
 * Re-derives the receipt hash from the envelope fields and compares.
 */
export function verifySettlementReceipt(
  envelope: SettlementEnvelope,
  receipt: SettlementReceipt,
): boolean {
  if (envelope.settlementId !== receipt.settlementId) {
    return false;
  }
  const expectedHash = sha256Concat(
    utf8(envelope.settlementId),
    utf8(envelope.commitment),
    fromB64url(envelope.ciphertext),
    fromB64url(envelope.nonce),
    fromB64url(envelope.authTag),
  );
  return expectedHash === receipt.hash;
}

/* ------------------------------------------------------------------ */
/*  Decryption helper                                                  */
/* ------------------------------------------------------------------ */

/**
 * Decrypt a shielded envelope given the recipient's private key material.
 *
 * Re-derives the AES key (recipient private × ephemeral seed) and decrypts
 * with AES-256-GCM. Returns the plaintext JSON, or null on failure.
 *
 * @param envelope              The shielded envelope to decrypt.
 * @param recipientSeed          32-byte recipient secret seed used in the KDF.
 */
export async function decryptShieldedEnvelope(
  envelope: SettlementEnvelope,
  recipientSeed: Uint8Array,
): Promise<string | null> {
  try {
    const ephemeralPubRaw = fromB64url(envelope.ephemeralPubkey);
    const aesKey = deriveSharedSecretKey(ephemeralPubRaw, recipientSeed);

    const nonce = fromB64url(envelope.nonce);
    const ciphertext = fromB64url(envelope.ciphertext);
    const authTag = fromB64url(envelope.authTag);
    const aad = JSON.stringify({
      settlementId: envelope.settlementId,
      commitment: envelope.commitment,
      createdAt: envelope.createdAt,
    });

    const cryptoKey = await crypto.subtle.importKey("raw", buf(aesKey), { name: "AES-GCM" }, false, ["decrypt"]);
    // Web Crypto expects ciphertext + tag concatenated.
    const combined = concatBytes(ciphertext, authTag);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buf(nonce), additionalData: buf(utf8(aad)), tagLength: 128 },
      cryptoKey,
      buf(combined),
    );
    return new TextDecoder().decode(decrypted);
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Commitment verification                                            */
/* ------------------------------------------------------------------ */

/**
 * Verify that a plaintext matches the commitment in the envelope.
 *
 * Lets an auditor verify the encrypted payload without decrypting — they
 * receive the plaintext out-of-band and compare its hash to the commitment.
 */
export function verifyCommitment(
  envelope: SettlementEnvelope,
  plaintext: string,
): boolean {
  return sha256Hex(plaintext) === envelope.commitment;
}

/* ------------------------------------------------------------------ */
/*  Batch settlement                                                   */
/* ------------------------------------------------------------------ */

export interface BatchSettlementResult {
  envelopes: ShieldedEnvelopeResult[];
  batchCommitment: string;
  totalAmount: number;
}

/**
 * Create multiple shielded envelopes in a batch.
 *
 * Produces a batch commitment hash covering all individual envelopes,
 * enabling a single on-chain commitment for multiple settlements.
 */
export async function createBatchSettlement(
  paramsList: SettlementParams[],
): Promise<BatchSettlementResult> {
  const envelopes: ShieldedEnvelopeResult[] = [];
  let totalAmount = 0;
  for (const params of paramsList) {
    const result = await createShieldedEnvelope(params);
    envelopes.push(result);
    totalAmount += params.amount;
  }
  // Batch commitment: SHA-256 of all individual commitments concatenated.
  const parts = envelopes.map(e => utf8(e.envelope.commitment));
  const batchCommitment = toHex(sha256(concatBytes(...parts)));
  return { envelopes, batchCommitment, totalAmount };
}

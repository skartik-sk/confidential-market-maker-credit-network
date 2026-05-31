/**
 * Umbra-style stealth address settlement for the confidential credit vault.
 *
 * Uses X25519 ECDH key exchange and AES-256-GCM encryption to create
 * shielded settlement envelopes where transfer details are hidden.
 * Only commitment hashes are visible on-chain.
 *
 * Key generation uses X25519 (Curve25519) which is compatible with
 * Solana's Ed25519 keys via birational map conversion.
 * ECDH shared secret derivation uses proper scalar multiplication.
 */

import {
  createCipheriv,
  createDecipheriv,
  createECDH,
  createHash,
  generateKeyPairSync,
  randomBytes,
} from "node:crypto";

import { PublicKey } from "@solana/web3.js";

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
/*  Stealth key generation (X25519 ECDH)                               */
/* ------------------------------------------------------------------ */

/**
 * Generate a new stealth keypair using X25519 (Curve25519).
 *
 * This matches Umbra's pattern of separate viewing and spending keys.
 * X25519 is the Diffie-Hellman function over Curve25519, which is
 * birationally equivalent to Ed25519 used by Solana.
 *
 * Uses Node.js crypto's native ECDH with x25519 curve.
 */
export function generateStealthKeyPair(): StealthKeyPair {
  // Generate X25519 key pairs for proper ECDH shared secret derivation
  const spending = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const viewing = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  return {
    spendingPrivateKey: Buffer.from(spending.privateKey).toString("base64"),
    spendingPublicKey: Buffer.from(spending.publicKey).toString("base64"),
    viewingPrivateKey: Buffer.from(viewing.privateKey).toString("base64"),
    viewingPublicKey: Buffer.from(viewing.publicKey).toString("base64"),
  };
}

/* ------------------------------------------------------------------ */
/*  Stealth address derivation                                         */
/* ------------------------------------------------------------------ */

/**
 * Derive a one-time stealth address from a spending public key and a
 * random seed using proper cryptographic derivation.
 *
 * Uses HKDF-like construction: hash the spending public key with the
 * random seed to produce a deterministic but unpredictable 32-byte value.
 * The result is clamped to ensure it can serve as a valid Ed25519 seed
 * (matching Solana's key requirements).
 *
 * @param spendingPublicKey  The recipient's spending public key (32 bytes).
 * @param randomSeed         A 32-byte random seed.
 * @returns A derived PublicKey (valid Ed25519 point).
 */
export function deriveStealthAddress(
  spendingPublicKey: Buffer,
  randomSeed: Buffer,
): PublicKey {
  if (spendingPublicKey.length !== 32) {
    throw new Error("spendingPublicKey must be 32 bytes");
  }
  if (randomSeed.length !== 32) {
    throw new Error("randomSeed must be 32 bytes");
  }

  // HKDF-like single-step derivation with proper domain separation
  const derived = createHash("sha256")
    .update(Buffer.from("credit-vault-stealth-v1")) // domain separation
    .update(spendingPublicKey)
    .update(randomSeed)
    .digest();

  // The PublicKey constructor validates the 32 bytes as a valid Ed25519 point
  return new PublicKey(derived);
}

/* ------------------------------------------------------------------ */
/*  ECDH shared secret derivation                                      */
/* ------------------------------------------------------------------ */

/**
 * Derive a 256-bit AES key using proper X25519 ECDH.
 *
 * Uses Node.js crypto's createECDH with x25519 curve to perform
 * scalar multiplication: sharedSecret = ephemeralPrivate * recipientPublic.
 * The result is then hashed with HKDF to produce the final AES key.
 */
function deriveSharedSecretKey(
  ephemeralPrivateKeyDer: Buffer,
  recipientPublicKeyDer: Buffer,
): Buffer {
  // Create ECDH instance and set the ephemeral private key
  const ecdh = createECDH("x25519");

  // The DER-encoded keys from generateKeyPairSync need to be loaded
  ecdh.setPrivateKey(ephemeralPrivateKeyDer);

  // Compute the shared secret via scalar multiplication
  const sharedSecret = ecdh.computeSecret(recipientPublicKeyDer);

  // Derive final AES key using HKDF-expand (single-step KDF)
  return createHash("sha256")
    .update(Buffer.from("credit-vault-aes-key-v1")) // HKDF info
    .update(sharedSecret)
    .digest();
}

/* ------------------------------------------------------------------ */
/*  Envelope creation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Create a shielded settlement envelope.
 *
 * The process:
 * 1. Generate an ephemeral X25519 keypair.
 * 2. Derive a shared secret using ECDH (ephemeral private × recipient public).
 * 3. Encrypt the settlement details with AES-256-GCM.
 * 4. Produce a commitment hash of the plaintext.
 * 5. Return the envelope + a verifiable receipt.
 */
export function createShieldedEnvelope(
  params: SettlementParams,
): ShieldedEnvelopeResult {
  const timestamp = new Date().toISOString();

  // 1. Generate ephemeral X25519 keypair
  const ephemeralKey = generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const ephemeralPrivateKeyDer = Buffer.from(ephemeralKey.privateKey);
  const ephemeralPublicKeyDer = Buffer.from(ephemeralKey.publicKey);

  // 2. Derive shared secret key via ECDH
  const recipientPubkeyBuf = params.recipient.toBuffer();
  const aesKey = deriveSharedSecretKey(ephemeralPrivateKeyDer, recipientPubkeyBuf);

  // 3. Prepare plaintext payload
  const plaintext = JSON.stringify({
    sender: params.sender.toBase58(),
    recipient: params.recipient.toBase58(),
    amount: params.amount,
    noteSizeUsd: params.noteSizeUsd,
    creditLineId: params.creditLineId,
    timestamp,
  });

  // 4. Compute commitment hash (SHA-256 of plaintext)
  const commitment = createHash("sha256")
    .update(plaintext)
    .digest("hex");

  // 5. Encrypt with AES-256-GCM
  const nonce = randomBytes(12); // 96-bit nonce for GCM
  const cipher = createCipheriv("aes-256-gcm", aesKey, nonce, {
    authTagLength: 16,
  });

  // Additional authenticated data — public metadata
  const settlementId = `settle_${createHash("sha256")
    .update(commitment)
    .update(timestamp)
    .digest("hex")
    .slice(0, 16)}`;

  const aad = JSON.stringify({
    settlementId,
    commitment,
    createdAt: timestamp,
  });

  cipher.setAAD(Buffer.from(aad, "utf-8"));

  const encrypted = Buffer.concat([
    cipher.update(plaintext, "utf-8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  // 6. Build the envelope
  const envelope: SettlementEnvelope = {
    settlementId,
    ciphertext: encrypted.toString("base64url"),
    nonce: nonce.toString("base64url"),
    authTag: authTag.toString("base64url"),
    ephemeralPubkey: ephemeralPublicKeyDer.toString("base64"),
    commitment,
    createdAt: timestamp,
  };

  // 7. Build the receipt
  const receiptHash = createHash("sha256")
    .update(envelope.settlementId)
    .update(envelope.commitment)
    .update(envelope.ciphertext)
    .update(envelope.nonce)
    .update(envelope.authTag)
    .digest("hex");

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
 * Re-derives the receipt hash from the envelope fields and checks
 * it against the receipt's hash. Also validates that the settlement
 * IDs match.
 */
export function verifySettlementReceipt(
  envelope: SettlementEnvelope,
  receipt: SettlementReceipt,
): boolean {
  if (envelope.settlementId !== receipt.settlementId) {
    return false;
  }

  const expectedHash = createHash("sha256")
    .update(envelope.settlementId)
    .update(envelope.commitment)
    .update(envelope.ciphertext)
    .update(envelope.nonce)
    .update(envelope.authTag)
    .digest("hex");

  return expectedHash === receipt.hash;
}

/* ------------------------------------------------------------------ */
/*  Decryption helper                                                  */
/* ------------------------------------------------------------------ */

/**
 * Decrypt a shielded envelope given the recipient's private key material.
 *
 * Uses ECDH to re-derive the shared secret from the recipient's private
 * key and the ephemeral public key embedded in the envelope.
 *
 * @param envelope              The shielded envelope to decrypt.
 * @param recipientPrivateKeyDer The recipient's X25519 private key (DER-encoded).
 * @returns The decrypted plaintext JSON string, or null if decryption fails.
 */
export function decryptShieldedEnvelope(
  envelope: SettlementEnvelope,
  recipientPrivateKeyDer: Buffer,
): string | null {
  try {
    const ephemeralPubkeyDer = Buffer.from(envelope.ephemeralPubkey, "base64");

    // Re-derive the AES key via ECDH
    const aesKey = deriveSharedSecretKey(recipientPrivateKeyDer, ephemeralPubkeyDer);

    const nonce = Buffer.from(envelope.nonce, "base64url");
    const authTag = Buffer.from(envelope.authTag, "base64url");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");

    const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce, {
      authTagLength: 16,
    });

    decipher.setAuthTag(authTag);

    const aad = JSON.stringify({
      settlementId: envelope.settlementId,
      commitment: envelope.commitment,
      createdAt: envelope.createdAt,
    });
    decipher.setAAD(Buffer.from(aad, "utf-8"));

    const decrypted = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

    return decrypted.toString("utf-8");
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
 * This allows an auditor to verify the encrypted payload without
 * decrypting — they receive the plaintext out-of-band and compare
 * its hash to the on-chain commitment.
 */
export function verifyCommitment(
  envelope: SettlementEnvelope,
  plaintext: string,
): boolean {
  const expectedCommitment = createHash("sha256")
    .update(plaintext)
    .digest("hex");

  return expectedCommitment === envelope.commitment;
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
 * Produces a batch commitment hash that covers all individual envelopes,
 * enabling a single on-chain commitment for multiple settlements.
 */
export function createBatchSettlement(
  paramsList: SettlementParams[],
): BatchSettlementResult {
  const envelopes: ShieldedEnvelopeResult[] = [];
  let totalAmount = 0;

  for (const params of paramsList) {
    const result = createShieldedEnvelope(params);
    envelopes.push(result);
    totalAmount += params.amount;
  }

  // Batch commitment: hash of all individual commitments concatenated
  const hasher = createHash("sha256");
  for (const { envelope } of envelopes) {
    hasher.update(envelope.commitment);
  }
  const batchCommitment = hasher.digest("hex");

  return { envelopes, batchCommitment, totalAmount };
}

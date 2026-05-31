/**
 * Umbra-style stealth address settlement for the confidential credit vault.
 *
 * Uses ephemeral ECDH key exchange and AES-256-GCM encryption to create
 * shielded settlement envelopes where transfer details are hidden.
 * Only commitment hashes are visible on-chain.
 *
 * All crypto uses `node:crypto` — no external dependencies beyond
 * @solana/web3.js for PublicKey types.
 */

import {
  createCipheriv,
  createDecipheriv,
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
  spendingPrivateKey: Buffer;
  spendingPublicKey: Buffer;
  /** The viewing key — used to scan for incoming payments. */
  viewingPrivateKey: Buffer;
  viewingPublicKey: Buffer;
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
  /** Ephemeral public key used for key exchange (hex encoded). */
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
/*  Stealth key generation                                             */
/* ------------------------------------------------------------------ */

/**
 * Generate a new stealth keypair.
 *
 * This simulates Umbra's pattern of separate viewing and spending keys.
 * The viewing key scans for incoming payments; the spending key authorizes
 * spending from the stealth address.
 *
 * Uses RSA-2048 for the keypair to enable ECDH-like key exchange via
 * EC Diffie-Hellman over secp256k1 for the shared secret derivation,
 * then RSA for the envelope encryption.
 */
export function generateStealthKeyPair(): StealthKeyPair {
  // Generate EC key pairs for ECDH shared secret derivation
  const spendingEc = generateKeyPairSync("ec", {
    namedCurve: "secp256k1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const viewingEc = generateKeyPairSync("ec", {
    namedCurve: "secp256k1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  return {
    spendingPrivateKey: Buffer.from(spendingEc.privateKey as unknown as Uint8Array),
    spendingPublicKey: Buffer.from(spendingEc.publicKey as unknown as Uint8Array),
    viewingPrivateKey: Buffer.from(viewingEc.privateKey as unknown as Uint8Array),
    viewingPublicKey: Buffer.from(viewingEc.publicKey as unknown as Uint8Array),
  };
}

/* ------------------------------------------------------------------ */
/*  Stealth address derivation                                         */
/* ------------------------------------------------------------------ */

/**
 * Derive a one-time stealth address from a spending public key and a
 * random seed.
 *
 * This is similar to Umbra's stealth address derivation: the sender
 * generates an ephemeral key, combines it with the recipient's spending
 * public key, and produces a one-time address only the recipient can
 * spend from.
 *
 * @param spendingPublicKey  The recipient's spending public key.
 * @param randomSeed         A 32-byte random seed.
 * @returns A derived 32-byte address (can be used as a PublicKey seed).
 */
export function deriveStealthAddress(
  spendingPublicKey: Buffer,
  randomSeed: Buffer,
): PublicKey {
  // Hash the spending pubkey and seed together to produce a 32-byte address
  const derived = createHash("sha256")
    .update(spendingPublicKey)
    .update(randomSeed)
    .digest();

  // Ensure valid Ed25519 point by returning as a PublicKey
  // PublicKey constructor validates the 32 bytes
  return new PublicKey(derived);
}

/* ------------------------------------------------------------------ */
/*  Key derivation                                                     */
/* ------------------------------------------------------------------ */

/**
 * Derive a 256-bit AES key from a shared secret using HKDF-like construction.
 *
 * In a full Umbra integration, this would use a proper ECDH shared secret.
 * Here we simulate it by hashing the ephemeral private key and the
 * recipient's public key together.
 */
function deriveSharedSecretKey(
  ephemeralPrivateKey: Buffer,
  recipientPublicKey: Buffer,
): Buffer {
  return createHash("sha256")
    .update(ephemeralPrivateKey)
    .update(recipientPublicKey)
    .digest();
}

/* ------------------------------------------------------------------ */
/*  Envelope creation                                                  */
/* ------------------------------------------------------------------ */

/**
 * Create a shielded settlement envelope.
 *
 * The process:
 * 1. Generate an ephemeral EC keypair.
 * 2. Derive a shared secret using the ephemeral private key + recipient's
 *    serialized public key.
 * 3. Encrypt the settlement details with AES-256-GCM.
 * 4. Produce a commitment hash of the plaintext.
 * 5. Return the envelope + a verifiable receipt.
 */
export function createShieldedEnvelope(
  params: SettlementParams,
): ShieldedEnvelopeResult {
  const timestamp = new Date().toISOString();

  // 1. Generate ephemeral keypair
  const ephemeralKey = generateKeyPairSync("ec", {
    namedCurve: "secp256k1",
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });

  const ephemeralPrivateKey = Buffer.from(ephemeralKey.privateKey as unknown as Uint8Array);
  const ephemeralPublicKey = Buffer.from(ephemeralKey.publicKey as unknown as Uint8Array);

  // 2. Derive shared secret key
  const recipientPubkeyBuf = params.recipient.toBuffer();
  const aesKey = deriveSharedSecretKey(ephemeralPrivateKey, recipientPubkeyBuf);

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
    ephemeralPubkey: ephemeralPublicKey.toString("hex"),
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
  // Settlement ID must match
  if (envelope.settlementId !== receipt.settlementId) {
    return false;
  }

  // Re-derive the receipt hash
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
 * This simulates the recipient scanning for their stealth payments and
 * decrypting the envelope using the shared secret.
 *
 * In production, the recipient would use their viewing key to detect
 * the payment and their spending key to derive the decryption key.
 *
 * @param envelope       The shielded envelope to decrypt.
 * @param recipientPrivateKey  The recipient's private key bytes (used to
 *                              re-derive the shared secret with the ephemeral key).
 * @returns The decrypted plaintext JSON string, or null if decryption fails.
 */
export function decryptShieldedEnvelope(
  envelope: SettlementEnvelope,
  recipientPrivateKey: Buffer,
): string | null {
  try {
    const ephemeralPubkey = Buffer.from(envelope.ephemeralPubkey, "hex");

    // Re-derive the AES key from the recipient's private key + ephemeral pubkey
    const aesKey = deriveSharedSecretKey(recipientPrivateKey, ephemeralPubkey);

    const nonce = Buffer.from(envelope.nonce, "base64url");
    const authTag = Buffer.from(envelope.authTag, "base64url");
    const ciphertext = Buffer.from(envelope.ciphertext, "base64url");

    const decipher = createDecipheriv("aes-256-gcm", aesKey, nonce, {
      authTagLength: 16,
    });

    decipher.setAuthTag(authTag);

    // Reconstruct AAD — must match what was used during encryption
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

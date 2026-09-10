/**
 * Encrypted note backup — password-protected export/import of StoredNotes.
 *
 * Notes (valueUsd + blinding) live ONLY in this browser's localStorage; a
 * backup is the only way to survive "clear browser data". The backup file is
 * itself encrypted so it can sit in a Downloads folder / cloud drive safely:
 *
 *   key    = scrypt(password, salt(16B), N=2^15, r=8, p=1, dkLen=32)
 *   ct     = AES-256-GCM(key, nonce(12B), JSON.stringify(notes))
 *   envelope = { v: 1, salt, nonce, ct }   // all binary fields base64
 *
 * GCM authentication makes a wrong password or a tampered ciphertext fail
 * loudly on decrypt — never silently produce garbage notes.
 *
 * Browser-safe: uses @noble/hashes + @noble/ciphers (pure JS) and the Web
 * Crypto RNG. No node:crypto.
 */

import { scryptAsync } from "@noble/hashes/scrypt";
import { gcm } from "@noble/ciphers/aes";
import type { StoredNote } from "./persistence";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

/** The on-disk envelope. Binary fields are base64. */
export interface BackupEnvelope {
  v: 1;
  /** Base64 scrypt salt (16 bytes). */
  salt: string;
  /** Base64 AES-GCM nonce (12 bytes). */
  nonce: string;
  /** Base64 ciphertext + 16-byte GCM tag. */
  ct: string;
}

/* ------------------------------------------------------------------ */
/*  Constants + low-level helpers                                      */
/* ------------------------------------------------------------------ */

const SALT_LEN = 16;
const NONCE_LEN = 12;
const KEY_LEN = 32;

/** scrypt parameters: ~32 MB memory, sub-second on a phone, real KDF cost. */
const SCRYPT_OPTS = { N: 2 ** 15, r: 8, p: 1, dkLen: KEY_LEN } as const;

const STATUSES: readonly StoredNote["status"][] = ["drawn", "listed", "repaid", "defaulted"];

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

function toB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

function fromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ */
/*  Validation                                                         */
/* ------------------------------------------------------------------ */

/**
 * Shape-check one candidate note. Anything that doesn't look like a complete
 * StoredNote (wrong types, unknown status, non-finite value) is rejected so a
 * corrupt or hand-edited backup can never poison local storage.
 */
function isValidStoredNote(n: unknown): n is StoredNote {
  if (typeof n !== "object" || n === null || Array.isArray(n)) return false;
  const o = n as Record<string, unknown>;
  return (
    typeof o.id === "string" && o.id.length > 0 &&
    typeof o.creditLineId === "string" &&
    typeof o.valueUsd === "number" && Number.isFinite(o.valueUsd) &&
    typeof o.blinding === "string" &&
    typeof o.commitment === "string" && o.commitment.length > 0 &&
    typeof o.drawnAt === "number" && Number.isFinite(o.drawnAt) &&
    typeof o.status === "string" && (STATUSES as readonly string[]).includes(o.status) &&
    typeof o.market === "string"
  );
}

/* ------------------------------------------------------------------ */
/*  Export                                                             */
/* ------------------------------------------------------------------ */

/**
 * Encrypt a note set under `password` and return the JSON envelope string.
 *
 * Throws if the password is shorter than 8 characters (a weak password on a
 * file containing every private note value is worse than no backup).
 */
export async function exportEncryptedBackup(
  notes: StoredNote[],
  password: string,
): Promise<string> {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await scryptAsync(password, salt, SCRYPT_OPTS);
  const plaintext = new TextEncoder().encode(JSON.stringify(notes));
  const ct = gcm(key, nonce).encrypt(plaintext);
  const envelope: BackupEnvelope = {
    v: 1,
    salt: toB64(salt),
    nonce: toB64(nonce),
    ct: toB64(ct),
  };
  return JSON.stringify(envelope);
}

/* ------------------------------------------------------------------ */
/*  Import                                                             */
/* ------------------------------------------------------------------ */

/**
 * Decrypt an envelope produced by `exportEncryptedBackup` back into notes.
 *
 * Throws a descriptive error on: malformed JSON, wrong envelope version,
 * wrong password, tampered ciphertext (GCM auth failure) or non-JSON
 * plaintext. Entries that don't shape-check as StoredNotes are skipped.
 */
export async function importEncryptedBackup(
  envelopeJson: string,
  password: string,
): Promise<StoredNote[]> {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(envelopeJson);
  } catch {
    throw new Error("Not a valid backup file (malformed JSON)");
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Not a valid backup envelope");
  }
  const env = raw as Record<string, unknown>;
  if (env.v !== 1 || typeof env.salt !== "string" || typeof env.nonce !== "string" || typeof env.ct !== "string") {
    throw new Error("Unsupported backup envelope (expected v:1 with salt/nonce/ct)");
  }

  let salt: Uint8Array;
  let nonce: Uint8Array;
  let ct: Uint8Array;
  try {
    salt = fromB64(env.salt);
    nonce = fromB64(env.nonce);
    ct = fromB64(env.ct);
  } catch {
    throw new Error("Backup envelope contains corrupt base64 fields");
  }
  if (salt.length !== SALT_LEN || nonce.length !== NONCE_LEN || ct.length <= 16) {
    throw new Error("Backup envelope fields have wrong lengths");
  }

  const key = await scryptAsync(password, salt, SCRYPT_OPTS);
  let plain: Uint8Array;
  try {
    plain = gcm(key, nonce).decrypt(ct);
  } catch {
    // GCM tag mismatch ⇒ wrong password OR tampered file — same failure.
    throw new Error("Decryption failed — wrong password or tampered backup");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error("Backup decrypted but its contents are not valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Backup does not contain a note list");
  }

  return parsed.filter(isValidStoredNote);
}

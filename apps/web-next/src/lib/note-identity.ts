/**
 * Per-browser encryption identity for shielded settlement envelopes.
 *
 * Every browser generates an X25519 keypair (the "note identity"). The public
 * half is shared with counterparties so they can encrypt settlement envelopes
 * TO this browser via real ECDH (see lib/stealth-settlement.ts); the private
 * half never leaves localStorage and is what lets the receiver decrypt.
 *
 * Browser-only: all functions guard on `typeof window` so importing this
 * module from server code is safe (they return null / throw there).
 */

import { x25519 } from "@noble/curves/ed25519";
import { fromHex, toHex } from "./sha256";

/** localStorage key holding the JSON-serialized identity. */
export const IDENTITY_STORAGE_KEY = "mute-identity-v1";

export interface IdentityPublicKey {
  /** 32-byte X25519 public key, hex encoded (64 chars). Safe to share. */
  pubHex: string;
}

export interface IdentityKeyPair extends IdentityPublicKey {
  /** 32-byte X25519 private key, hex encoded (64 chars). NEVER share. */
  privHex: string;
}

function storage(): Storage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    // localStorage can throw (privacy mode, disabled storage) — degrade.
    return null;
  }
}

/**
 * Read the stored identity's public key, or null if none exists yet.
 * (The private half is intentionally NOT returned here — call
 * `createIdentity` results are held by the caller when needed.)
 */
export function getIdentity(): IdentityPublicKey | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IdentityKeyPair>;
    if (typeof parsed?.pubHex !== "string" || !/^[0-9a-f]{64}$/i.test(parsed.pubHex)) return null;
    return { pubHex: parsed.pubHex.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Read the FULL stored identity (public + private halves), or null.
 * Only the receiver/decrypt path needs the private half.
 */
export function getIdentityKeyPair(): IdentityKeyPair | null {
  const store = storage();
  if (!store) return null;
  try {
    const raw = store.getItem(IDENTITY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IdentityKeyPair>;
    if (
      typeof parsed?.pubHex !== "string" ||
      typeof parsed?.privHex !== "string" ||
      !/^[0-9a-f]{64}$/i.test(parsed.pubHex) ||
      !/^[0-9a-f]{64}$/i.test(parsed.privHex)
    ) {
      return null;
    }
    return { pubHex: parsed.pubHex.toLowerCase(), privHex: parsed.privHex.toLowerCase() };
  } catch {
    return null;
  }
}

/**
 * Generate a fresh X25519 identity and persist it, replacing any existing one.
 * Returns both halves — the caller is responsible for keeping `privHex` out of
 * any network payload.
 */
export function createIdentity(): IdentityKeyPair {
  const priv = x25519.utils.randomPrivateKey();
  const pub = x25519.getPublicKey(priv);
  const identity: IdentityKeyPair = { privHex: toHex(priv), pubHex: toHex(pub) };
  const store = storage();
  if (!store) {
    throw new Error("note-identity requires a browser (localStorage unavailable)");
  }
  store.setItem(IDENTITY_STORAGE_KEY, JSON.stringify(identity));
  return identity;
}

/**
 * Convenience: return the stored identity, creating one if none exists.
 * Returns null only when storage is unavailable (server render / private mode).
 */
export function ensureIdentity(): IdentityKeyPair | null {
  const existing = getIdentityKeyPair();
  if (existing) return existing;
  if (typeof window === "undefined") return null;
  try {
    return createIdentity();
  } catch {
    return null;
  }
}

/** Decode a hex identity private key into 32 raw bytes (validates length). */
export function identityPrivBytes(privHex: string): Uint8Array {
  const bytes = fromHex(privHex.trim().toLowerCase().replace(/^0x/, ""));
  if (bytes.length !== 32) {
    throw new Error("identity private key must be 32 bytes of hex");
  }
  return bytes;
}

/** Decode a hex identity public key into 32 raw bytes (validates length). */
export function identityPubBytes(pubHex: string): Uint8Array {
  const bytes = fromHex(pubHex.trim().toLowerCase().replace(/^0x/, ""));
  if (bytes.length !== 32) {
    throw new Error("identity public key must be 32 bytes of hex");
  }
  return bytes;
}

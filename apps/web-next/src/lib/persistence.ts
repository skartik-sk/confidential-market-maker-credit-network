/**
 * Persistent user state using localStorage with HMAC integrity protection.
 *
 * Stores per-wallet credit vault state: pool address, credit line address,
 * transaction history, USDC balance, and last-updated timestamp.
 *
 * Integrity: Each stored blob includes an HMAC-SHA256 checksum derived from
 * the wallet pubkey. Tampered data is rejected on load.
 *
 * Browser-safe: uses a pure-JS SHA-256 (no node:crypto) so this works in the
 * client bundle. All functions are SSR-safe (check typeof window first).
 */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface TxRecord {
  /** Transaction signature. */
  signature: string;
  /** Type of transaction (e.g. "draw", "repay", "delegate", "commit"). */
  type: string;
  /** Slot the transaction was finalized in. */
  slot: number;
  /** Status: "confirmed", "finalized", "failed". */
  status: string;
  /** Unix timestamp (ms) when the record was created. */
  timestamp: number;
}

export interface UserState {
  /** Pool address the user belongs to. */
  poolAddress: string;
  /** Credit line address. */
  creditLineAddress: string;
  /** Transaction history (max 50 entries). */
  transactions: TxRecord[];
  /** Cached USDC balance in smallest units. */
  usdcBalance: number;
  /** Unix timestamp (ms) of last state update. */
  lastUpdated: number;
}

/* ------------------------------------------------------------------ */
/*  Internal helpers                                                   */
/* ------------------------------------------------------------------ */

const MAX_TRANSACTIONS = 50;

function storageKey(walletPubkey: string): string {
  return `cv_${walletPubkey}`;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof localStorage !== "undefined";
}

/** Derive an HMAC key from the wallet pubkey. This isn't secret — it just detects tampering. */
function hmacKey(walletPubkey: string): Uint8Array {
  return sha256(utf8("credit-vault-integrity-v1" + walletPubkey));
}

/** Compute HMAC-SHA256 of serialized state (browser-safe, synchronous). */
function computeHmac(walletPubkey: string, data: string): string {
  return hmacSha256(hmacKey(walletPubkey), utf8(data));
}

/* ------------------------------------------------------------------ */
/*  Pure-JS SHA-256 + HMAC-SHA256 (browser-compatible, synchronous)    */
/* ------------------------------------------------------------------ */

function utf8(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, "0");
  return out;
}

const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256(data: Uint8Array): Uint8Array {
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const bitLen = data.length * 8;
  // Pad: append 0x80, zeros, then 64-bit big-endian length.
  const padded = new Uint8Array(((data.length + 9 + 63) >> 6) << 6);
  padded.set(data);
  padded[data.length] = 0x80;
  // High 32 bits of length (always 0 for our sizes) then low 32 bits.
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) | 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const mj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + mj) | 0;
      hh = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0; h[1] = (h[1] + b) | 0; h[2] = (h[2] + c) | 0; h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0; h[5] = (h[5] + f) | 0; h[6] = (h[6] + g) | 0; h[7] = (h[7] + hh) | 0;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i] >>> 0, false);
  return out;
}

function rotr(x: number, n: number): number {
  return (x >>> n) | (x << (32 - n));
}

function hmacSha256(key: Uint8Array, msg: Uint8Array): string {
  const blockSize = 64;
  let k = key;
  if (k.length > blockSize) k = sha256(k);
  const paddedKey = new Uint8Array(blockSize);
  paddedKey.set(k);
  const ipad = new Uint8Array(blockSize);
  const opad = new Uint8Array(blockSize);
  for (let i = 0; i < blockSize; i++) {
    ipad[i] = paddedKey[i] ^ 0x36;
    opad[i] = paddedKey[i] ^ 0x5c;
  }
  const inner = new Uint8Array(blockSize + msg.length);
  inner.set(ipad);
  inner.set(msg, blockSize);
  const innerHash = sha256(inner);
  const outer = new Uint8Array(blockSize + 32);
  outer.set(opad);
  outer.set(innerHash, blockSize);
  return toHex(sha256(outer));
}

interface StoredBlob {
  state: UserState;
  hmac: string;
}

/* ------------------------------------------------------------------ */
/*  Core CRUD                                                          */
/* ------------------------------------------------------------------ */

/**
 * Save (merge) partial user state into localStorage.
 *
 * Merges the provided fields into whatever is already stored for this wallet,
 * then updates `lastUpdated` automatically.
 */
export function saveUserState(
  walletPubkey: string,
  state: Partial<UserState>,
): void {
  if (!isBrowser()) return;

  const key = storageKey(walletPubkey);
  const existing = loadUserState(walletPubkey);

  const merged: UserState = {
    poolAddress: state.poolAddress ?? existing?.poolAddress ?? "",
    creditLineAddress: state.creditLineAddress ?? existing?.creditLineAddress ?? "",
    transactions: state.transactions ?? existing?.transactions ?? [],
    usdcBalance: state.usdcBalance ?? existing?.usdcBalance ?? 0,
    lastUpdated: Date.now(),
  };

  try {
    const stateJson = JSON.stringify(merged);
    const hmac = computeHmac(walletPubkey, stateJson);
    localStorage.setItem(key, JSON.stringify({ state: merged, hmac }));
  } catch {
    // localStorage may be full or disabled; silently degrade.
  }
}

/**
 * Load the stored user state for a wallet.
 *
 * Returns `null` when nothing is stored or the data is corrupt.
 */
export function loadUserState(walletPubkey: string): UserState | null {
  if (!isBrowser()) return null;

  const key = storageKey(walletPubkey);
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const blob = JSON.parse(raw) as StoredBlob;
    // HMAC integrity check — reject tampered data
    const stateJson = JSON.stringify(blob.state);
    const expectedHmac = computeHmac(walletPubkey, stateJson);
    if (blob.hmac !== expectedHmac) return null;
    const parsed = blob.state;
    // Basic shape validation.
    if (typeof parsed.poolAddress !== "string") return null;
    if (typeof parsed.creditLineAddress !== "string") return null;
    if (!Array.isArray(parsed.transactions)) return null;
    if (typeof parsed.usdcBalance !== "number") return null;
    if (typeof parsed.lastUpdated !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Append a transaction record to the stored history.
 *
 * Keeps at most `MAX_TRANSACTIONS` entries (newest first). If the same
 * signature already exists the record is updated in-place.
 */
export function addTransaction(
  walletPubkey: string,
  tx: TxRecord,
): void {
  if (!isBrowser()) return;

  const existing = loadUserState(walletPubkey);
  const transactions = existing?.transactions ?? [];

  // Deduplicate: replace if signature matches.
  const idx = transactions.findIndex((t) => t.signature === tx.signature);
  if (idx >= 0) {
    transactions[idx] = tx;
  } else {
    transactions.unshift(tx);
  }

  // Trim to max.
  if (transactions.length > MAX_TRANSACTIONS) {
    transactions.length = MAX_TRANSACTIONS;
  }

  saveUserState(walletPubkey, { transactions });
}

/**
 * Clear all stored state for a wallet.
 */
export function clearUserState(walletPubkey: string): void {
  if (!isBrowser()) return;

  const key = storageKey(walletPubkey);
  try {
    localStorage.removeItem(key);
  } catch {
    // Silently degrade.
  }
}

/**
 * Export the stored user state as a JSON string suitable for backup/download.
 *
 * Returns `null` when nothing is stored.
 */
export function exportUserState(walletPubkey: string): string | null {
  const state = loadUserState(walletPubkey);
  if (!state) return null;

  return JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      wallet: walletPubkey,
      state,
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------ */
/*  Query helpers                                                      */
/* ------------------------------------------------------------------ */

/**
 * Get transactions of a specific type for a wallet.
 */
export function getTransactionsByType(
  walletPubkey: string,
  type: string,
): TxRecord[] {
  const state = loadUserState(walletPubkey);
  if (!state) return [];
  return state.transactions.filter((t) => t.type === type);
}

/**
 * Get the most recent N transactions for a wallet.
 */
export function getRecentTransactions(
  walletPubkey: string,
  limit: number = 10,
): TxRecord[] {
  const state = loadUserState(walletPubkey);
  if (!state) return [];
  return state.transactions.slice(0, Math.min(limit, state.transactions.length));
}

/**
 * Compute a simple summary of stored transaction history.
 */
export function getTransactionSummary(walletPubkey: string): {
  total: number;
  confirmed: number;
  failed: number;
  byType: Record<string, number>;
} {
  const state = loadUserState(walletPubkey);
  const transactions = state?.transactions ?? [];

  let confirmed = 0;
  let failed = 0;
  const byType: Record<string, number> = {};

  for (const tx of transactions) {
    if (tx.status === "confirmed" || tx.status === "finalized") {
      confirmed++;
    } else if (tx.status === "failed") {
      failed++;
    }
    byType[tx.type] = (byType[tx.type] ?? 0) + 1;
  }

  return { total: transactions.length, confirmed, failed, byType };
}

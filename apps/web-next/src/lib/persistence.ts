/**
 * Persistent user state using localStorage.
 *
 * Stores per-wallet credit vault state: pool address, credit line address,
 * transaction history, USDC balance, and last-updated timestamp.
 *
 * All functions are SSR-safe (check typeof window before localStorage access).
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
    localStorage.setItem(key, JSON.stringify(merged));
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
    const parsed = JSON.parse(raw) as UserState;
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

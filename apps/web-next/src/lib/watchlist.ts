/**
 * Watchlist persistence for the exchange markets table.
 *
 * Stores the user's starred market symbols in localStorage under
 * `mute-watchlist` so watched markets survive reloads and are pinned
 * first in the Markets table.
 *
 * Browser-safe and SSR-safe (checks `typeof window` before touching storage).
 */

const KEY = "mute-watchlist";

/** Read the starred market symbols (newest last). Empty when unset/corrupt. */
export function getWatchlist(): string[] {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

function saveWatchlist(symbols: string[]): void {
  if (typeof window === "undefined" || typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify(symbols));
  } catch {
    // localStorage may be full or disabled; silently degrade.
  }
}

/** Toggle a symbol in the watchlist. Returns the updated list (also persisted). */
export function toggleWatch(symbol: string): string[] {
  const current = getWatchlist();
  const next = current.includes(symbol)
    ? current.filter(s => s !== symbol)
    : [...current, symbol];
  saveWatchlist(next);
  return next;
}

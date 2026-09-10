"use client";

/**
 * Sortable overview table for all exchange markets — the "Table" side of the
 * market-selector Table/Cards toggle.
 *
 * - Live spot price / 24h change (when the price stream has the asset), note
 *   market price as % of par, 24h volume, maturity.
 * - Watchlist stars persist via lib/watchlist (localStorage); watchlisted
 *   markets are pinned above the rest regardless of sort.
 * - Row click selects the market (same as tapping a card).
 *
 * SSR-safe: the component only mounts after a client-side click (Cards is
 * the default view), so lazily reading localStorage in useState is safe.
 */

import { useMemo, useState } from "react";
import { getWatchlist, toggleWatch } from "@/lib/watchlist";

export interface MarketRow {
  symbol: string;
  asset: string;
  maturityDays: number;
  /** Note market price as a fraction of par (0.97 = 97%). */
  lastPrice: number;
  volume24hUsd: number;
  spotPriceUsd: number | null;
  spotChange24hPct: number | null;
}

type SortKey = "symbol" | "spot" | "change" | "volume" | "maturity" | "note";

const COLUMNS: { key: SortKey; label: string; align: "left" | "right" }[] = [
  { key: "symbol", label: "Market", align: "left" },
  { key: "note", label: "Note %", align: "right" },
  { key: "spot", label: "Spot", align: "right" },
  { key: "change", label: "24h", align: "right" },
  { key: "volume", label: "24h Volume", align: "right" },
  { key: "maturity", label: "Maturity", align: "right" },
];

function fmtSpot(v: number): string {
  return v >= 1000 ? `$${(v / 1000).toFixed(1)}k` : `$${v.toFixed(2)}`;
}

function fmtUsdCompact(v: number): string {
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `$${(v / 1e3).toFixed(1)}k`;
  return `$${v.toFixed(0)}`;
}

export function MarketsTable({ markets, activeSymbol, onSelect }: {
  markets: MarketRow[];
  activeSymbol: string;
  onSelect: (symbol: string) => void;
}) {
  const [watch, setWatch] = useState<string[]>(() => getWatchlist());
  const [sortKey, setSortKey] = useState<SortKey>("volume");
  const [sortDir, setSortDir] = useState<1 | -1>(-1);

  const rows = useMemo(() => {
    const sortValue = (m: MarketRow): number | string => {
      switch (sortKey) {
        case "symbol": return m.symbol;
        case "spot": return m.spotPriceUsd ?? Number.NEGATIVE_INFINITY;
        case "change": return m.spotChange24hPct ?? Number.NEGATIVE_INFINITY;
        case "volume": return m.volume24hUsd;
        case "maturity": return m.maturityDays;
        case "note": return m.lastPrice;
      }
    };
    const sorted = [...markets].sort((a, b) => {
      const va = sortValue(a), vb = sortValue(b);
      if (typeof va === "string" || typeof vb === "string") {
        return sortDir * String(va).localeCompare(String(vb));
      }
      return sortDir * (va - vb);
    });
    // Watchlisted markets pinned first (order preserved within each group).
    return [
      ...sorted.filter(m => watch.includes(m.symbol)),
      ...sorted.filter(m => !watch.includes(m.symbol)),
    ];
  }, [markets, sortKey, sortDir, watch]);

  const onSort = (key: SortKey) => {
    if (key === sortKey) setSortDir(d => (d === 1 ? -1 : 1));
    else {
      setSortKey(key);
      setSortDir(key === "symbol" ? 1 : -1);
    }
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-xs mono">
        <thead>
          <tr className="border-b border-line text-muted text-[10px] uppercase">
            <th className="px-3 py-2 text-left font-medium w-8" aria-label="Watchlist" />
            {COLUMNS.map(c => (
              <th key={c.key} className={`px-3 py-2 ${c.align === "right" ? "text-right" : "text-left"} font-medium`}>
                <button
                  onClick={() => onSort(c.key)}
                  className={`inline-flex items-center gap-1 uppercase transition-colors ${sortKey === c.key ? "text-ink font-bold" : "hover:text-ink"}`}
                  aria-label={`Sort by ${c.label}`}
                >
                  {c.label}
                  <span className="text-[8px]">{sortKey === c.key ? (sortDir === 1 ? "▲" : "▼") : "△"}</span>
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map(m => {
            const isActive = m.symbol === activeSymbol;
            const watched = watch.includes(m.symbol);
            const up = (m.spotChange24hPct ?? 0) >= 0;
            return (
              <tr
                key={m.symbol}
                onClick={() => onSelect(m.symbol)}
                className={`border-b border-line/40 transition-colors cursor-pointer ${isActive ? "bg-red-soft/40" : "hover:bg-bg"}`}
              >
                <td className="px-3 py-2">
                  <button
                    onClick={e => { e.stopPropagation(); setWatch(toggleWatch(m.symbol)); }}
                    aria-label={watched ? `Remove ${m.symbol} from watchlist` : `Add ${m.symbol} to watchlist`}
                    aria-pressed={watched}
                    className={`text-sm leading-none transition-colors ${watched ? "text-amber" : "text-muted hover:text-amber"}`}
                  >
                    {watched ? "★" : "☆"}
                  </button>
                </td>
                <td className="px-3 py-2 font-bold whitespace-nowrap">
                  <span className="inline-flex items-center gap-1.5">
                    {m.symbol}
                    {isActive && <span className="w-1 h-1 rounded-full bg-red" />}
                    {m.spotPriceUsd != null && <span className="w-1.5 h-1.5 rounded-full bg-green animate-glow" title="live price" />}
                  </span>
                  <span className="ml-1.5 text-[10px] text-muted font-normal">{m.asset}</span>
                </td>
                <td className="px-3 py-2 text-right">{(m.lastPrice * 100).toFixed(1)}</td>
                <td className="px-3 py-2 text-right font-semibold">{m.spotPriceUsd != null ? fmtSpot(m.spotPriceUsd) : "—"}</td>
                <td className={`px-3 py-2 text-right ${m.spotChange24hPct != null ? (up ? "text-green" : "text-red") : "text-muted"}`}>
                  {m.spotChange24hPct != null ? `${up ? "▲" : "▼"} ${Math.abs(m.spotChange24hPct).toFixed(2)}%` : "—"}
                </td>
                <td className="px-3 py-2 text-right text-muted">{fmtUsdCompact(m.volume24hUsd)}</td>
                <td className="px-3 py-2 text-right text-muted">{m.maturityDays}d</td>
              </tr>
            );
          })}
          {rows.length === 0 && (
            <tr><td colSpan={7} className="px-3 py-8 text-center text-muted">No markets loaded yet…</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

export default MarketsTable;

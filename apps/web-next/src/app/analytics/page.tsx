"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ThemeToggle } from "@/components/ThemeToggle";

/* ------------------------------------------------------------------ */
/*  Types (mirror lib/exchange-store — kept local on purpose)          */
/* ------------------------------------------------------------------ */

interface Market {
  symbol: string; asset: string; maturityDays: number; baseNoteSizeUsd: number;
  lastPrice: number; change24hBps: number; volume24hUsd: number; high24h: number; low24h: number;
  spotPriceUsd: number | null;
  spotChange24hPct: number | null;
  spotMarketCapUsd: number | null;
}
interface NoteListing {
  id: string; seller: string; noteCount: number; noteSizeUsd: number; faceValueUsd: number;
  askPriceUsd: number; discountBps: number; yieldBps: number; daysToMaturity: number;
  privacy: string; creditLineId: string; market: string; createdAt: number; status: string;
  demo?: boolean; chainSig?: string;
}
interface Trade {
  id: string; listingId: string; buyer: string; seller: string; noteCount: number;
  faceValueUsd: number; priceUsd: number; discountBps: number; settlementId: string; timestamp: number;
  paymentSig?: string;
}
interface ExchangeStats {
  activeListings: number; totalNotesListed: number; totalFaceValueUsd: number;
  tradeCount: number; totalVolumeUsd: number; avgDiscountBps: number; bestYieldBps: number;
}

const API = process.env.NEXT_PUBLIC_API_URL ?? "";
const REFRESH_MS = 15_000;

async function get<T>(p: string): Promise<T | null> {
  try { const r = await fetch(`${API}${p}`); return r.ok ? r.json() : null; } catch { return null; }
}

function fmtUsd(v: number): string {
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtCompact(v: number): string {
  if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(2)}M`;
  if (v >= 1_000) return `$${(v / 1_000).toFixed(1)}k`;
  return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/* ------------------------------------------------------------------ */
/*  SVG bar chart — volume24hUsd per market                            */
/* ------------------------------------------------------------------ */

function VolumeChart({ markets }: { markets: Market[] }) {
  const W = 720, H = 240, PAD_L = 8, PAD_R = 8, PAD_T = 22, PAD_B = 26;
  const data = [...markets].sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  if (data.length === 0)
    return <div className="h-[240px] flex items-center justify-center text-muted text-sm">No market data yet</div>;

  const max = Math.max(1, ...data.map(m => m.volume24hUsd));
  const cw = (W - PAD_L - PAD_R) / data.length;
  const barW = Math.min(72, cw * 0.55);
  const chartH = H - PAD_T - PAD_B;
  const gridLines = 4;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }} role="img" aria-label="24h volume per market">
      {/* gridlines */}
      {Array.from({ length: gridLines + 1 }, (_, i) => {
        const y = PAD_T + (chartH * i) / gridLines;
        return <line key={i} x1={PAD_L} y1={y} x2={W - PAD_R} y2={y} className="stroke-line" strokeWidth={0.5} />;
      })}
      {data.map((m, i) => {
        const h = Math.max(m.volume24hUsd > 0 ? 3 : 1, (m.volume24hUsd / max) * chartH);
        const x = PAD_L + cw * (i + 0.5) - barW / 2;
        const y = PAD_T + chartH - h;
        const up = m.change24hBps >= 0;
        return (
          <g key={m.symbol}>
            <rect x={x} y={y} width={barW} height={h} rx={2}
              className={up ? "fill-green" : "fill-red"}
              opacity={m.volume24hUsd > 0 ? 0.92 : 0.25}>
              <title>{`${m.symbol} — 24h volume ${fmtUsd(m.volume24hUsd)}`}</title>
            </rect>
            <text x={PAD_L + cw * (i + 0.5)} y={y - 6} textAnchor="middle" fontSize={10} fontWeight={700}
              className="mono fill-ink">{m.volume24hUsd > 0 ? fmtCompact(m.volume24hUsd) : "—"}</text>
            <text x={PAD_L + cw * (i + 0.5)} y={H - 8} textAnchor="middle" fontSize={9}
              className="mono fill-muted">{m.symbol}</text>
          </g>
        );
      })}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AnalyticsPage() {
  const [stats, setStats] = useState<ExchangeStats | null>(null);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [listings, setListings] = useState<NoteListing[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    const [s, mk, tr, ls] = await Promise.all([
      get<ExchangeStats>("/api/exchange/stats"),
      get<{ markets: Market[] }>("/api/exchange/markets"),
      get<{ trades: Trade[] }>("/api/exchange/trades?limit=50"),
      get<{ listings: NoteListing[] }>("/api/exchange/listings?status=active"),
    ]);
    if (s) setStats(s);
    if (mk?.markets?.length) setMarkets(mk.markets);
    if (tr) setTrades(tr.trades ?? []);
    if (ls) setListings(ls.listings ?? []);
    setLoaded(true);
  }, []);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    const id = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(id);
  }, [refresh]);

  const loading = !loaded;

  const volume24h = useMemo(() => markets.reduce((s, m) => s + (m.volume24hUsd || 0), 0), [markets]);
  const asks = useMemo(() => [...listings].sort((a, b) => a.askPriceUsd - b.askPriceUsd), [listings]);

  const kpis: { label: string; value: string; sub?: string; accent?: string }[] = [
    { label: "24h Volume", value: fmtCompact(volume24h), sub: stats ? `${fmtCompact(stats.totalVolumeUsd)} all-time` : undefined, accent: "text-green" },
    { label: "Total Trades", value: stats ? `${stats.tradeCount}` : "—", sub: "settled fills" },
    { label: "Active Listings", value: stats ? `${stats.activeListings}` : "—", sub: stats ? `${stats.totalNotesListed} notes on book` : undefined, accent: "text-red" },
    { label: "Markets", value: markets.length ? `${markets.length}` : "—", sub: "note markets" },
    { label: "Face Value Listed", value: stats ? fmtCompact(stats.totalFaceValueUsd) : "—", sub: stats ? `avg disc ${(stats.avgDiscountBps / 100).toFixed(2)}%` : undefined },
  ];

  return (
    <div className="min-h-screen bg-bg">
      {/* Header — consistent with Trade/Exchange */}
      <header className="border-b border-line bg-paper/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-[1840px] mx-auto px-3 sm:px-5 h-14 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-6 min-w-0">
            <Link href="/" className="text-lg font-bold tracking-tight shrink-0">Mute</Link>
            <nav className="flex gap-0.5 sm:gap-1">
              <Link href="/" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors rounded whitespace-nowrap">Dashboard</Link>
              <Link href="/trade" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors rounded whitespace-nowrap">Trade</Link>
              <Link href="/exchange" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors rounded whitespace-nowrap">Exchange</Link>
              <span className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs font-semibold text-red bg-red-soft rounded whitespace-nowrap">Analytics</span>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] mono text-green bg-green-soft px-2 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green animate-glow" /> DEVNET LIVE
            </span>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-5 sm:px-6 py-8">
        {/* Title */}
        <div className="flex items-end justify-between flex-wrap gap-3 mb-6 animate-fade">
          <div>
            <p className="section-tag mb-2">Exchange</p>
            <h1 className="text-3xl font-black tracking-tight">Platform Analytics</h1>
          </div>
          <span className="mono text-[10px] text-muted uppercase">auto-refresh {REFRESH_MS / 1000}s</span>
        </div>

        {/* KPI cards */}
        {loading ? (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            {Array.from({ length: 5 }, (_, i) => (
              <div key={i} className="card p-5 animate-pulse">
                <div className="h-8 rounded bg-line/60 mb-2" />
                <div className="h-2 rounded bg-line/60 w-2/3" />
              </div>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3 mb-6">
            {kpis.map(k => (
              <div key={k.label} className="card p-5">
                <p className="mono text-[10px] text-muted uppercase">{k.label}</p>
                <p className={`text-2xl font-bold mono mt-1.5 ${k.accent ?? "text-ink"}`}>{k.value}</p>
                {k.sub && <p className="mono text-[10px] text-muted mt-1">{k.sub}</p>}
              </div>
            ))}
          </div>
        )}

        {/* Chart + asks */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 mb-4">
          {/* Volume per market */}
          <section className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line flex items-center justify-between">
              <span className="text-xs font-bold">24h Volume per Market</span>
              <span className="text-[10px] mono text-muted">▲ green = up · ▼ red = down (24h)</span>
            </div>
            <div className="px-3 py-3">
              {loading ? (
                <div className="h-[240px] flex items-end gap-3 animate-pulse px-2 pb-6">
                  {[70, 45, 90, 30, 60].map((h, i) => (
                    <div key={i} className="flex-1 rounded-t bg-line/60" style={{ height: `${h}%` }} />
                  ))}
                </div>
              ) : (
                <VolumeChart markets={markets} />
              )}
            </div>
          </section>

          {/* Active asks */}
          <section className="card overflow-hidden">
            <div className="px-4 py-3 border-b border-line flex items-center justify-between">
              <span className="text-xs font-bold">Active Asks — All Markets</span>
              <span className="text-[10px] mono text-muted">{asks.length}</span>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs mono min-w-[560px]">
                <thead>
                  <tr className="border-b border-line text-muted text-[10px] uppercase">
                    <th className="px-4 py-2 text-left font-medium">Market</th>
                    <th className="px-4 py-2 text-right font-medium">Notes</th>
                    <th className="px-4 py-2 text-right font-medium">Face</th>
                    <th className="px-4 py-2 text-right font-medium">Ask</th>
                    <th className="px-4 py-2 text-right font-medium">Disc%</th>
                    <th className="px-4 py-2 text-left font-medium">Privacy</th>
                    <th className="px-4 py-2 text-left font-medium">Chain</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    Array.from({ length: 4 }, (_, i) => (
                      <tr key={i} className="border-b border-line/40 animate-pulse">
                        <td colSpan={7} className="px-4 py-2.5"><div className="h-3 rounded bg-line/60 w-full" /></td>
                      </tr>
                    ))
                  ) : asks.length === 0 ? (
                    <tr><td colSpan={7} className="px-4 py-10 text-center text-muted">No active asks — list notes on the Exchange</td></tr>
                  ) : asks.map(l => (
                    <tr key={l.id} className="border-b border-line/40 hover:bg-red-soft/30 transition-colors">
                      <td className="px-4 py-2 font-semibold whitespace-nowrap">{l.market}</td>
                      <td className="px-4 py-2 text-right">{l.noteCount}</td>
                      <td className="px-4 py-2 text-right text-muted">{fmtUsd(l.faceValueUsd)}</td>
                      <td className="px-4 py-2 text-right font-semibold text-green">{fmtUsd(l.askPriceUsd)}</td>
                      <td className="px-4 py-2 text-right text-red">{(l.discountBps / 100).toFixed(2)}</td>
                      <td className="px-4 py-2">
                        <span className="px-1.5 py-0.5 rounded bg-bg border border-line text-muted text-[11px] whitespace-nowrap">{l.privacy}</span>
                      </td>
                      <td className="px-4 py-2 text-[10px] whitespace-nowrap">
                        {l.demo ? (
                          <span className="px-1.5 py-0.5 rounded bg-bg border border-line text-muted" title="Synthetic demo liquidity — no on-chain record exists for this ask">demo</span>
                        ) : l.chainSig ? (
                          <a href={`https://explorer.solana.com/tx/${l.chainSig}?cluster=devnet`} target="_blank" rel="noreferrer"
                            className="text-green hover:underline" title={`Recorded on devnet — verify: ${l.chainSig}`}>on-chain ✓</a>
                        ) : (
                          <span className="text-muted" title="Chain record pending wallet confirmation">…</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {/* Recent trades */}
        <section className="card overflow-hidden">
          <div className="px-4 py-3 border-b border-line flex items-center justify-between">
            <span className="text-xs font-bold">Recent Trades</span>
            <span className="text-[10px] mono text-muted">last {REFRESH_MS / 1000}s window · {trades.length} fills</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs mono min-w-[640px]">
              <thead>
                <tr className="border-b border-line text-muted text-[10px] uppercase">
                  <th className="px-4 py-2 text-left font-medium">Time</th>
                  <th className="px-4 py-2 text-right font-medium">% of Par</th>
                  <th className="px-4 py-2 text-right font-medium">Notes</th>
                  <th className="px-4 py-2 text-right font-medium">Value</th>
                  <th className="px-4 py-2 text-left font-medium">Settlement</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  Array.from({ length: 4 }, (_, i) => (
                    <tr key={i} className="border-b border-line/40 animate-pulse">
                      <td colSpan={5} className="px-4 py-2.5"><div className="h-3 rounded bg-line/60 w-full" /></td>
                    </tr>
                  ))
                ) : trades.length === 0 ? (
                  <tr><td colSpan={5} className="px-4 py-10 text-center text-muted">No trades yet</td></tr>
                ) : trades.map(t => {
                  const pctPar = 100 - t.discountBps / 100;
                  return (
                    <tr key={t.id} className="border-b border-line/40 hover:bg-green-soft/30 transition-colors">
                      <td className="px-4 py-2 text-muted whitespace-nowrap">{fmtTime(t.timestamp)}</td>
                      <td className="px-4 py-2 text-right font-medium">{pctPar.toFixed(2)}%</td>
                      <td className="px-4 py-2 text-right">{t.noteCount}</td>
                      <td className="px-4 py-2 text-right text-muted">{fmtUsd(t.priceUsd)}</td>
                      <td className="px-4 py-2 whitespace-nowrap">
                        {t.paymentSig ? (
                          <a href={`https://explorer.solana.com/tx/${t.paymentSig}?cluster=devnet`} target="_blank" rel="noreferrer"
                            className="text-green hover:underline" title={`Real USDC payment on devnet: ${t.paymentSig}`}>paid ✓</a>
                        ) : (
                          <span className="text-muted" title="USDC payment not yet recorded">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <p className="mono text-[10px] text-muted mt-6 leading-relaxed">
          Prices are % of par implied by each trade&apos;s discount. Note values stay confidential — only ask prices, discounts and settlement commitments are public.
        </p>
      </main>
    </div>
  );
}

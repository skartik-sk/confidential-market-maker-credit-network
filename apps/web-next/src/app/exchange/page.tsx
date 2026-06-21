"use client";

import { useState, useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { useWallet } from "@solana/wallet-adapter-react";
import { PublicKey } from "@solana/web3.js";
import Link from "next/link";
import { createShieldedEnvelope } from "@/lib/stealth-settlement";
import type { PrivacyPolicyLabel } from "@/lib/exchange-store";

const WalletMultiButtonDynamic = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then(m => m.WalletMultiButton),
  { ssr: false }
);

/* ------------------------------------------------------------------ */
/*  Types (mirror lib/exchange-store)                                  */
/* ------------------------------------------------------------------ */

interface Market {
  symbol: string; asset: string; maturityDays: number; baseNoteSizeUsd: number;
  lastPrice: number; change24hBps: number; volume24hUsd: number; high24h: number; low24h: number;
}
interface Candle { time: number; open: number; high: number; low: number; close: number; volumeUsd: number; }
interface NoteListing {
  id: string; seller: string; noteCount: number; noteSizeUsd: number; faceValueUsd: number;
  askPriceUsd: number; discountBps: number; yieldBps: number; daysToMaturity: number;
  privacy: string; creditLineId: string; market: string; createdAt: number; status: string;
}
interface Trade {
  id: string; listingId: string; buyer: string; seller: string; noteCount: number;
  faceValueUsd: number; priceUsd: number; discountBps: number; settlementId: string; timestamp: number;
}
interface OrderBookLevel { priceBps: number; notes: number; total: number; faceUsd: number; }
interface OrderBook { market: string; asks: OrderBookLevel[]; bids: OrderBookLevel[]; }

const PRIVACY_OPTIONS: PrivacyPolicyLabel[] = ["Public", "Umbra", "Arcium", "Umbra+Arcium", "MagicBlock"];
const API = process.env.NEXT_PUBLIC_API_URL ?? "";

/* ------------------------------------------------------------------ */
/*  Mini sparkline for market cards                                    */
/* ------------------------------------------------------------------ */

function Sparkline({ candles, up }: { candles: Candle[]; up: boolean }) {
  if (candles.length < 2) return <svg width="56" height="20" />;
  const closes = candles.map(c => c.close);
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = max - min || 1;
  const W = 56, H = 20;
  const pts = closes.map((c, i) => `${(i / (closes.length - 1)) * W},${H - ((c - min) / range) * H}`).join(" ");
  const color = up ? "#1fad60" : "#dc2b28";
  return (
    <svg width={W} height={H} className="shrink-0">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  SVG Candlestick chart with volume bars                             */
/* ------------------------------------------------------------------ */

function CandleChart({ candles }: { candles: Candle[] }) {
  const W = 760, H = 340, PAD_L = 8, PAD_R = 58, PAD_T = 10, PAD_B = 16;
  const VOL_H = 44; // volume band height
  if (candles.length === 0)
    return <div className="h-[340px] flex items-center justify-center text-muted text-sm">Loading chart…</div>;
  const prices = candles.flatMap(c => [c.high, c.low]);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 0.001;
  const priceTop = PAD_T, priceBot = H - PAD_B - VOL_H;
  const y = (p: number) => priceTop + (1 - (p - min) / range) * (priceBot - priceTop);
  const cw = (W - PAD_L - PAD_R) / candles.length;
  const bodyW = Math.max(2, cw * 0.62);
  const gridLines = 4;
  const maxVol = Math.max(...candles.map(c => c.volumeUsd), 1);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      {/* price grid */}
      {Array.from({ length: gridLines + 1 }, (_, i) => {
        const p = min + (range * i) / gridLines;
        const yy = y(p);
        return <g key={i}>
          <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke="#ece8e3" strokeWidth={0.5} />
          <text x={W - PAD_R + 4} y={yy + 3} fontSize={9} fill="#9a928a" className="mono">{(p * 100).toFixed(1)}</text>
        </g>;
      })}
      {/* candles */}
      {candles.map((c, i) => {
        const cx = PAD_L + cw * (i + 0.5);
        const up = c.close >= c.open;
        const color = up ? "#1fad60" : "#dc2b28";
        const yO = y(c.open), yC = y(c.close), yH = y(c.high), yL = y(c.low);
        const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yC - yO));
        const volH = (c.volumeUsd / maxVol) * (VOL_H - 6);
        return <g key={i}>
          <line x1={cx} y1={yH} x2={cx} y2={yL} stroke={color} strokeWidth={1} />
          <rect x={cx - bodyW / 2} y={top} width={bodyW} height={h} fill={color} rx={0.5} />
          <rect x={cx - bodyW / 2} y={H - PAD_B - volH} width={bodyW} height={volH} fill={color} opacity={0.22} />
        </g>;
      })}
      {/* last price line + tag */}
      {(() => {
        const last = candles[candles.length - 1].close;
        const yy = y(last);
        const up24 = candles[candles.length - 1].close >= candles[0].close;
        const color = up24 ? "#1fad60" : "#dc2b28";
        return <g>
          <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke={color} strokeWidth={0.8} strokeDasharray="3 3" />
          <rect x={W - PAD_R} y={yy - 8} width={PAD_R} height={16} fill={color} rx={2} />
          <text x={W - PAD_R + 4} y={yy + 3} fontSize={9.5} fontWeight={700} fill="#fff" className="mono">{(last * 100).toFixed(2)}</text>
        </g>;
      })()}
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ExchangePage() {
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [markets, setMarkets] = useState<Market[]>([]);
  const [activeMarket, setActiveMarket] = useState("USDC-30D");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [marketCandles, setMarketCandles] = useState<Record<string, Candle[]>>({});
  const [book, setBook] = useState<OrderBook | null>(null);
  const [listings, setListings] = useState<NoteListing[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [tf, setTf] = useState("1H");

  // Sell form
  const [noteCount, setNoteCount] = useState(5);
  const [pricePct, setPricePct] = useState(97);
  const [privacy, setPrivacy] = useState<PrivacyPolicyLabel>("Umbra+Arcium");

  const connected = wallet.connected && !!wallet.publicKey;

  const addLog = useCallback((msg: string) => {
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  const currentMarket = markets.find(m => m.symbol === activeMarket);
  const noteSizeUsd = currentMarket?.baseNoteSizeUsd ?? 1000;

  const refresh = useCallback(async () => {
    try {
      const [mk, ob, ls, tr] = await Promise.all([
        fetch(`${API}/api/exchange/markets`).then(r => r.json()),
        fetch(`${API}/api/exchange/orderbook?market=${activeMarket}`).then(r => r.json()),
        fetch(`${API}/api/exchange/listings?status=active`).then(r => r.json()),
        fetch(`${API}/api/exchange/trades?limit=12`).then(r => r.json()),
      ]);
      if (mk.markets?.length) { setMarkets(mk.markets); if (!markets.length) setActiveMarket(mk.markets[0].symbol); }
      setBook(ob);
      setListings((ls.listings ?? []).filter((l: NoteListing) => l.market === activeMarket));
      setTrades(tr.trades ?? []);
    } catch { /* keep stale */ }
  }, [activeMarket, markets.length]);

  const refreshCandles = useCallback(async () => {
    try {
      const cd = await fetch(`${API}/api/exchange/candles?market=${activeMarket}&limit=48`).then(r => r.json());
      const next = cd.candles ?? [];
      setCandles(next);
      setMarketCandles(prev => ({ ...prev, [activeMarket]: next }));
    } catch { /* keep stale */ }
  }, [activeMarket]);

  useEffect(() => { refresh(); refreshCandles(); }, [refresh, refreshCandles, activeMarket]);
  useEffect(() => { const id = setInterval(refresh, 6000); return () => clearInterval(id); }, [refresh]);

  const marketListings = useMemo(() => listings.filter(l => l.market === activeMarket), [listings, activeMarket]);

  const sellFaceValue = noteCount * noteSizeUsd;
  const sellAskPrice = Math.round(sellFaceValue * (pricePct / 100));
  const sellDiscountBps = Math.round((100 - pricePct) * 100);
  const sellYield = sellAskPrice > 0 && (currentMarket?.maturityDays ?? 1) > 0
    ? Math.round(((sellFaceValue - sellAskPrice) / sellAskPrice) * (365 / (currentMarket?.maturityDays ?? 1)) * 10000) : 0;

  /* Sell: list notes */
  const handleSell = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      if (pricePct > 100) { addLog("Price cannot exceed par (100%)"); setBusy(false); return; }
      addLog(`Listing ${noteCount} ${activeMarket} notes at ${pricePct}% of par…`);
      const res = await fetch(`${API}/api/exchange/listings`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller: wallet.publicKey.toBase58(),
          noteCount, noteSizeUsd, askPriceUsd: sellAskPrice,
          daysToMaturity: currentMarket?.maturityDays ?? 30, privacy,
          creditLineId: wallet.publicKey.toBase58().slice(0, 6) + "…" + wallet.publicKey.toBase58().slice(-4),
          market: activeMarket,
        }),
      });
      const data = await res.json();
      if (!res.ok) { addLog(`Sell failed: ${data.error}`); setBusy(false); return; }
      addLog(`✓ Listed ${data.listing.id} — ${sellDiscountBps / 100}% disc, ${(sellYield / 100).toFixed(1)}% APY`);
      await refresh();
    } catch (e: any) { addLog(`Sell failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, noteCount, noteSizeUsd, pricePct, privacy, activeMarket, currentMarket, sellAskPrice, sellDiscountBps, sellYield, addLog, refresh]);

  /* Buy: fill cheapest ask */
  const handleBuy = useCallback(async (listingId?: string) => {
    if (!wallet.publicKey) return;
    const target = listingId
      ? marketListings.find(l => l.id === listingId)
      : [...marketListings].sort((a, b) => a.askPriceUsd - b.askPriceUsd)[0];
    if (!target) { addLog("No asks in this market"); return; }
    setBusy(true);
    try {
      addLog(`Buying ${target.id}: ${target.noteCount} notes @ $${target.askPriceUsd.toLocaleString()}…`);
      const env = await createShieldedEnvelope({
        sender: wallet.publicKey,
        recipient: new PublicKey(target.seller.length >= 32 ? target.seller : wallet.publicKey),
        amount: target.askPriceUsd, noteSizeUsd: target.noteSizeUsd, creditLineId: target.creditLineId,
      });
      const res = await fetch(`${API}/api/exchange/buy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: target.id, buyer: wallet.publicKey.toBase58(), settlementId: env.envelope.settlementId }),
      });
      const data = await res.json();
      if (!res.ok) { addLog(`Buy failed: ${data.error}`); setBusy(false); return; }
      addLog(`✓ Filled ${data.trade.id} — shielded ${data.trade.settlementId}`);
      await refresh();
    } catch (e: any) { addLog(`Buy failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, marketListings, addLog, refresh]);

  const bestAsk = useMemo(() => [...marketListings].sort((a, b) => a.askPriceUsd - b.askPriceUsd)[0], [marketListings]);
  const spread = book && book.asks.length && book.bids.length
    ? Math.abs(book.asks[0].priceBps - book.bids[0].priceBps) : null;

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <header className="border-b border-line bg-paper/80 backdrop-blur sticky top-0 z-20">
        <div className="max-w-[1840px] mx-auto px-5 h-14 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-lg font-bold tracking-tight">Mute</Link>
            <nav className="flex gap-1">
              <Link href="/" className="px-3 py-1.5 text-xs text-muted hover:text-ink transition-colors rounded">Dashboard</Link>
              <Link href="/trade" className="px-3 py-1.5 text-xs text-muted hover:text-ink transition-colors rounded">Trade</Link>
              <span className="px-3 py-1.5 text-xs font-semibold text-red bg-red-soft rounded">Exchange</span>
            </nav>
          </div>
          <div className="flex items-center gap-3">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-[10px] mono text-green bg-green-soft px-2 py-1 rounded-full">
              <span className="w-1.5 h-1.5 rounded-full bg-green animate-glow" /> DEVNET LIVE
            </span>
            <span suppressHydrationWarning><WalletMultiButtonDynamic /></span>
          </div>
        </div>
      </header>

      <main className="max-w-[1840px] mx-auto px-5 py-4">
        {/* Market selector */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
          {markets.map(m => {
            const isActive = activeMarket === m.symbol;
            const up = m.change24hBps >= 0;
            const sp = marketCandles[m.symbol] ?? [];
            return (
              <button key={m.symbol} onClick={() => setActiveMarket(m.symbol)}
                className={`shrink-0 flex items-center gap-3 px-3.5 py-2 rounded-xl border transition-all ${isActive ? "border-red bg-paper shadow-sm" : "border-line bg-paper hover:border-red/30"}`}>
                <div className="text-left">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold">{m.symbol}</span>
                    {isActive && <span className="w-1 h-1 rounded-full bg-red" />}
                  </div>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    <span className="text-[11px] mono font-semibold">{(m.lastPrice * 100).toFixed(2)}</span>
                    <span className={`text-[10px] mono ${up ? "text-green" : "text-red"}`}>{up ? "▲" : "▼"}{(Math.abs(m.change24hBps) / 100).toFixed(2)}%</span>
                  </div>
                </div>
                <Sparkline candles={sp} up={up} />
              </button>
            );
          })}
        </div>

        {/* Top row: chart + order book */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-4 mb-4">
          {/* Chart panel */}
          <section className="card overflow-hidden">
            {currentMarket && (
              <div className="px-5 py-4 border-b border-line">
                <div className="flex items-end justify-between flex-wrap gap-3">
                  <div className="flex items-end gap-4">
                    <div>
                      <div className="flex items-center gap-2">
                        <h2 className="text-xl font-bold tracking-tight">{currentMarket.symbol}</h2>
                        <span className="text-[10px] mono text-muted px-1.5 py-0.5 border border-line rounded">{currentMarket.asset} · {currentMarket.maturityDays}d</span>
                      </div>
                      <div className="flex items-baseline gap-2 mt-1">
                        <span className="text-2xl font-bold mono">{(currentMarket.lastPrice * 100).toFixed(2)}</span>
                        <span className={`text-sm mono font-semibold ${currentMarket.change24hBps >= 0 ? "text-green" : "text-red"}`}>
                          {currentMarket.change24hBps >= 0 ? "+" : ""}{(currentMarket.change24hBps / 100).toFixed(2)}%
                        </span>
                      </div>
                    </div>
                    <div className="flex gap-5 text-[11px] mono pb-1">
                      <Stat label="24h High" value={(currentMarket.high24h * 100).toFixed(2)} />
                      <Stat label="24h Low" value={(currentMarket.low24h * 100).toFixed(2)} />
                      <Stat label="24h Vol" value={`$${(currentMarket.volume24hUsd / 1000).toFixed(1)}k`} />
                    </div>
                  </div>
                  <div className="flex gap-1">
                    {["1H", "4H", "1D", "1W"].map(t => (
                      <button key={t} onClick={() => setTf(t)}
                        className={`px-2.5 py-1 text-[10px] mono rounded ${tf === t ? "bg-ink text-paper" : "text-muted hover:text-ink"}`}>{t}</button>
                    ))}
                  </div>
                </div>
              </div>
            )}
            <div className="px-2 py-3">
              <CandleChart candles={candles} />
            </div>
            <div className="px-5 py-2 border-t border-line flex items-center justify-between">
              <p className="text-[10px] mono text-muted">Price = % of note face value (par = 100). Lower = bigger discount = higher yield.</p>
              <span className="text-[10px] mono text-muted">Vol bars below</span>
            </div>
          </section>

          {/* Order book */}
          <section className="card overflow-hidden flex flex-col">
            <div className="px-3 py-2.5 border-b border-line flex items-center justify-between">
              <span className="text-xs font-bold">Order Book</span>
              <span className="text-[10px] mono text-muted">{activeMarket}</span>
            </div>
            <div className="grid grid-cols-3 px-3 py-1.5 text-[9px] mono text-muted uppercase">
              <span>Price</span><span className="text-right">Notes</span><span className="text-right">Cumulative</span>
            </div>
            {/* Asks */}
            <div className="px-1.5 flex-1 overflow-hidden">
              {[...(book?.asks ?? [])].reverse().slice(-8).map((lv, i) => {
                const depthPct = Math.min(100, (lv.notes / Math.max(1, lv.total)) * 100);
                return <div key={`a${i}`} className="relative grid grid-cols-3 px-1.5 py-[3px] text-[11px] mono hover:bg-red-soft/40">
                  <div className="absolute right-0 top-0 h-full" style={{ width: `${depthPct}%`, background: "rgba(220,43,40,0.10)" }} />
                  <span className="text-red relative font-medium">{(lv.priceBps / 100).toFixed(2)}</span>
                  <span className="text-right relative">{lv.notes}</span>
                  <span className="text-right relative text-muted">{lv.total}</span>
                </div>;
              })}
            </div>
            {/* Mid / spread */}
            <div className="px-3 py-2 border-y border-line bg-bg flex items-center justify-between">
              <div>
                <span className="text-base font-bold mono">{currentMarket ? (currentMarket.lastPrice * 100).toFixed(2) : "—"}</span>
                <span className="text-[10px] mono text-muted ml-1">≈ ${((currentMarket?.lastPrice ?? 0) * (currentMarket?.baseNoteSizeUsd ?? 1000)).toFixed(0)}/note</span>
              </div>
              {spread != null && <span className="text-[10px] mono text-muted">spread {(spread / 100).toFixed(2)}</span>}
            </div>
            {/* Bids */}
            <div className="px-1.5 flex-1 overflow-hidden">
              {(book?.bids ?? []).slice(0, 8).map((lv, i) => {
                const depthPct = Math.min(100, (lv.notes / Math.max(1, lv.total)) * 100);
                return <div key={`b${i}`} className="relative grid grid-cols-3 px-1.5 py-[3px] text-[11px] mono hover:bg-green-soft/40">
                  <div className="absolute right-0 top-0 h-full" style={{ width: `${depthPct}%`, background: "rgba(31,173,96,0.10)" }} />
                  <span className="text-green relative font-medium">{(lv.priceBps / 100).toFixed(2)}</span>
                  <span className="text-right relative">{lv.notes}</span>
                  <span className="text-right relative text-muted">{lv.total}</span>
                </div>;
              })}
            </div>
          </section>
        </div>

        {/* Bottom row: trade panel + asks + trades/log */}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr_340px] gap-4">
          {/* Buy/Sell panel */}
          <section className="card p-4">
            <div className="flex gap-1 p-1 bg-bg rounded-lg mb-4">
              <button onClick={() => setSide("buy")} className={`flex-1 py-2 text-sm font-bold rounded-md transition-all ${side === "buy" ? "bg-green text-paper shadow-sm" : "text-muted"}`}>Buy</button>
              <button onClick={() => setSide("sell")} className={`flex-1 py-2 text-sm font-bold rounded-md transition-all ${side === "sell" ? "bg-red text-paper shadow-sm" : "text-muted"}`}>Sell</button>
            </div>
            {!connected ? (
              <div className="text-center py-8">
                <p className="text-sm text-muted mb-1">Wallet not connected</p>
                <p className="text-[11px] text-muted">Connect to trade confidentially.</p>
              </div>
            ) : side === "buy" ? (
              <>
                <p className="text-[11px] text-muted mb-3 leading-relaxed">Fill the best ask. Settlement is shielded with AES-256-GCM — only a commitment lands on-chain.</p>
                {bestAsk ? (
                  <div className="rounded-lg border border-line p-3 mb-3 mono text-xs space-y-1.5">
                    <RowKV label="Best ask" value={`$${bestAsk.askPriceUsd.toLocaleString()}`} valueClass="text-green" />
                    <RowKV label="Notes" value={`${bestAsk.noteCount} × $${bestAsk.noteSizeUsd}`} />
                    <RowKV label="Face value" value={`$${bestAsk.faceValueUsd.toLocaleString()}`} />
                    <RowKV label="Discount" value={`${(bestAsk.discountBps / 100).toFixed(2)}%`} valueClass="text-red" />
                    <RowKV label="Buyer APY" value={`${(bestAsk.yieldBps / 100).toFixed(1)}%`} valueClass="text-green" />
                  </div>
                ) : <div className="rounded-lg border border-dashed border-line p-4 mb-3 text-center text-[11px] text-muted">No active asks in {activeMarket}</div>}
                <button onClick={() => handleBuy()} disabled={busy || !bestAsk}
                  className="w-full py-2.5 rounded-lg bg-green text-paper text-sm font-bold disabled:opacity-30 hover:opacity-90 transition-opacity">
                  {busy ? "Processing…" : !bestAsk ? "No asks" : `Buy @ ${bestAsk ? (bestAsk.askPriceUsd / bestAsk.faceValueUsd * 100).toFixed(1) : ""}%`}
                </button>
              </>
            ) : (
              <>
                <div className="mb-3">
                  <div className="flex justify-between mb-1"><label className="text-[10px] mono text-muted uppercase">Notes to sell</label><span className="text-[10px] mono text-muted">${noteSizeUsd}/note</span></div>
                  <input type="number" min={1} value={noteCount} onChange={e => setNoteCount(Math.max(1, Number(e.target.value)))}
                    className="w-full bg-bg border border-line rounded-lg px-3 py-2 text-sm mono focus:outline-none focus:border-red/40" />
                </div>
                <div className="mb-3">
                  <div className="flex justify-between mb-1"><label className="text-[10px] mono text-muted uppercase">Price (% of par)</label><span className="text-[10px] mono text-muted">${sellAskPrice.toLocaleString()}</span></div>
                  <input type="number" min={1} max={100} step={0.5} value={pricePct} onChange={e => setPricePct(Number(e.target.value))}
                    className="w-full bg-bg border border-line rounded-lg px-3 py-2 text-sm mono focus:outline-none focus:border-red/40 mb-1.5" />
                  <div className="flex gap-1">
                    {[95, 96, 97, 98].map(p => (
                      <button key={p} onClick={() => setPricePct(p)} className="flex-1 py-1 text-[10px] mono bg-bg border border-line rounded hover:border-red/30">{p}%</button>
                    ))}
                  </div>
                </div>
                <div className="mb-3">
                  <label className="text-[10px] mono text-muted uppercase block mb-1">Privacy rail</label>
                  <select value={privacy} onChange={e => setPrivacy(e.target.value as PrivacyPolicyLabel)}
                    className="w-full bg-bg border border-line rounded-lg px-3 py-2 text-sm mono focus:outline-none focus:border-red/40">
                    {PRIVACY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div className="rounded-lg bg-bg p-3 mb-3 mono text-xs space-y-1.5">
                  <RowKV label="Face value" value={`$${sellFaceValue.toLocaleString()}`} />
                  <RowKV label="You receive" value={`$${sellAskPrice.toLocaleString()}`} valueClass="text-green" />
                  <RowKV label="Discount" value={`${(sellDiscountBps / 100).toFixed(2)}%`} valueClass="text-red" />
                  <RowKV label="Buyer APY" value={`${(sellYield / 100).toFixed(1)}%`} valueClass="text-green" />
                </div>
                <button onClick={handleSell} disabled={busy || pricePct > 100}
                  className="w-full py-2.5 rounded-lg bg-red text-paper text-sm font-bold disabled:opacity-30 hover:opacity-90 transition-opacity">
                  {pricePct > 100 ? "Above par (100%)" : `Sell ${noteCount} ${activeMarket} Notes`}
                </button>
              </>
            )}
          </section>

          {/* Active asks table */}
          <section className="card overflow-hidden">
            <div className="px-4 py-2.5 border-b border-line flex items-center justify-between">
              <span className="text-xs font-bold">Active Asks</span>
              <span className="text-[10px] mono text-muted">{activeMarket} · {marketListings.length}</span>
            </div>
            <table className="w-full text-xs mono">
              <thead><tr className="border-b border-line text-muted text-[10px] uppercase">
                <th className="px-4 py-2 text-left font-medium">Seller</th>
                <th className="px-4 py-2 text-right font-medium">Notes</th>
                <th className="px-4 py-2 text-right font-medium">Face</th>
                <th className="px-4 py-2 text-right font-medium">Ask</th>
                <th className="px-4 py-2 text-right font-medium">Disc%</th>
                <th className="px-4 py-2 text-right font-medium">APY</th>
                <th className="px-4 py-2 text-left font-medium">Privacy</th>
                <th className="px-4 py-2 text-right font-medium"></th>
              </tr></thead>
              <tbody>
                {marketListings.length === 0 ? (
                  <tr><td colSpan={8} className="px-4 py-12 text-center text-muted">
                    <p className="text-sm mb-1">No active asks in this market</p>
                    <p className="text-[11px]">Be the first — list your notes in the Sell panel.</p>
                  </td></tr>
                ) : [...marketListings].sort((a, b) => a.askPriceUsd - b.askPriceUsd).map(l => (
                  <tr key={l.id} className="border-b border-line/40 hover:bg-paper transition-colors group">
                    <td className="px-4 py-2 text-muted">{l.seller.slice(0, 6)}…{l.seller.slice(-4)}</td>
                    <td className="px-4 py-2 text-right">{l.noteCount}</td>
                    <td className="px-4 py-2 text-right text-muted">${l.faceValueUsd.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right font-semibold text-green">${l.askPriceUsd.toLocaleString()}</td>
                    <td className="px-4 py-2 text-right text-red">{(l.discountBps / 100).toFixed(2)}</td>
                    <td className="px-4 py-2 text-right text-green font-medium">{(l.yieldBps / 100).toFixed(1)}</td>
                    <td className="px-4 py-2 text-muted text-[11px]">{l.privacy}</td>
                    <td className="px-4 py-2 text-right">
                      <button onClick={() => handleBuy(l.id)} disabled={busy || !connected}
                        className="opacity-0 group-hover:opacity-100 text-[10px] px-2 py-1 rounded bg-green text-paper disabled:opacity-30 transition-opacity">Buy</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          {/* Recent trades + activity */}
          <section className="space-y-4">
            <div className="card overflow-hidden">
              <div className="px-3 py-2.5 border-b border-line flex items-center justify-between">
                <span className="text-xs font-bold">Market Trades</span>
                <span className="text-[10px] mono text-muted">{trades.length}</span>
              </div>
              <div className="grid grid-cols-3 px-3 py-1.5 text-[9px] mono text-muted uppercase border-b border-line/50">
                <span>Price</span><span className="text-right">Notes</span><span className="text-right">Value</span>
              </div>
              <div className="max-h-[200px] overflow-y-auto">
                {trades.length === 0 ? <p className="text-[11px] text-muted text-center py-6">No trades yet</p> :
                  trades.map(t => (
                    <div key={t.id} className="grid grid-cols-3 px-3 py-1.5 text-[11px] mono border-b border-line/20">
                      <span className="text-green">{(100 - t.discountBps / 100).toFixed(2)}</span>
                      <span className="text-right">{t.noteCount}</span>
                      <span className="text-right text-muted">${t.priceUsd.toLocaleString()}</span>
                    </div>
                  ))}
              </div>
            </div>
            <div className="card overflow-hidden">
              <div className="px-3 py-2.5 border-b border-line"><span className="text-xs font-bold">Activity</span></div>
              <div className="p-2 h-[150px] overflow-y-auto space-y-1 mono text-[11px]">
                {log.length === 0 ? <p className="text-muted text-center py-6 text-[11px]">No activity yet</p> :
                  log.map((l, i) => <div key={i} className="bg-bg rounded px-2 py-1 animate-slide">{l}</div>)}
              </div>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[9px] mono text-muted uppercase">{label}</p>
      <p className="text-ink font-medium">{value}</p>
    </div>
  );
}

function RowKV({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return <div className="flex justify-between"><span className="text-muted">{label}</span><span className={valueClass}>{value}</span></div>;
}

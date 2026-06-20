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
/*  SVG Candlestick chart                                              */
/* ------------------------------------------------------------------ */

function CandleChart({ candles }: { candles: Candle[] }) {
  const W = 720, H = 320, PAD_L = 8, PAD_R = 56, PAD_T = 12, PAD_B = 20;
  if (candles.length === 0) return <div className="h-[320px] flex items-center justify-center text-muted text-sm">No chart data</div>;
  const prices = candles.flatMap(c => [c.high, c.low]);
  const min = Math.min(...prices), max = Math.max(...prices);
  const range = max - min || 0.001;
  const y = (p: number) => PAD_T + (1 - (p - min) / range) * (H - PAD_T - PAD_B);
  const cw = (W - PAD_L - PAD_R) / candles.length;
  const bodyW = Math.max(2, cw * 0.6);
  const gridLines = 4;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ height: H }}>
      {/* grid */}
      {Array.from({ length: gridLines + 1 }, (_, i) => {
        const p = min + (range * i) / gridLines;
        const yy = y(p);
        return <g key={i}>
          <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke="#e6e1dc" strokeWidth={0.5} />
          <text x={W - PAD_R + 4} y={yy + 3} fontSize={9} fill="#8a8278" className="mono">{(p * 100).toFixed(1)}</text>
        </g>;
      })}
      {/* candles */}
      {candles.map((c, i) => {
        const cx = PAD_L + cw * (i + 0.5);
        const up = c.close >= c.open;
        const color = up ? "#16a34a" : "#dc2b28";
        const yO = y(c.open), yC = y(c.close), yH = y(c.high), yL = y(c.low);
        const top = Math.min(yO, yC), h = Math.max(1, Math.abs(yC - yO));
        return <g key={i}>
          <line x1={cx} y1={yH} x2={cx} y2={yL} stroke={color} strokeWidth={1} />
          <rect x={cx - bodyW / 2} y={top} width={bodyW} height={h} fill={color} />
        </g>;
      })}
      {/* last price line */}
      {(() => {
        const last = candles[candles.length - 1].close;
        const yy = y(last);
        return <g>
          <line x1={PAD_L} y1={yy} x2={W - PAD_R} y2={yy} stroke="#dc2b28" strokeWidth={0.8} strokeDasharray="3 3" />
          <rect x={W - PAD_R} y={yy - 8} width={PAD_R} height={16} fill="#dc2b28" />
          <text x={W - PAD_R + 4} y={yy + 3} fontSize={9} fill="#fff" className="mono">{(last * 100).toFixed(2)}</text>
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
  const [book, setBook] = useState<OrderBook | null>(null);
  const [listings, setListings] = useState<NoteListing[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [side, setSide] = useState<"buy" | "sell">("buy");

  // Sell form
  const [noteCount, setNoteCount] = useState(5);
  const [pricePct, setPricePct] = useState(97);
  const [privacy, setPrivacy] = useState<PrivacyPolicyLabel>("Umbra+Arcium");
  // Buy form
  const [buyNotes, setBuyNotes] = useState(1);

  const connected = wallet.connected && !!wallet.publicKey;

  const addLog = useCallback((msg: string) => {
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  const currentMarket = markets.find(m => m.symbol === activeMarket);
  const noteSizeUsd = currentMarket?.baseNoteSizeUsd ?? 1000;

  const refresh = useCallback(async () => {
    try {
      const [mk, cd, ob, ls, tr] = await Promise.all([
        fetch(`${API}/api/exchange/markets`).then(r => r.json()),
        fetch(`${API}/api/exchange/candles?market=${activeMarket}&limit=48`).then(r => r.json()),
        fetch(`${API}/api/exchange/orderbook?market=${activeMarket}`).then(r => r.json()),
        fetch(`${API}/api/exchange/listings?status=active`).then(r => r.json()),
        fetch(`${API}/api/exchange/trades?limit=12`).then(r => r.json()),
      ]);
      if (mk.markets?.length) { setMarkets(mk.markets); if (!markets.length) setActiveMarket(mk.markets[0].symbol); }
      setCandles(cd.candles ?? []);
      setBook(ob);
      setListings((ls.listings ?? []).filter((l: NoteListing) => l.market === activeMarket));
      setTrades(tr.trades ?? []);
    } catch { /* keep stale */ }
  }, [activeMarket, markets.length]);

  useEffect(() => { refresh(); const id = setInterval(refresh, 6000); return () => clearInterval(id); }, [refresh, activeMarket]);

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
  const handleBuy = useCallback(async () => {
    if (!wallet.publicKey) return;
    const cheapest = [...marketListings].sort((a, b) => a.askPriceUsd - b.askPriceUsd)[0];
    if (!cheapest) { addLog("No asks in this market"); return; }
    setBusy(true);
    try {
      addLog(`Buying ${cheapest.id}: ${cheapest.noteCount} notes @ $${cheapest.askPriceUsd.toLocaleString()}…`);
      const env = await createShieldedEnvelope({
        sender: wallet.publicKey,
        recipient: new PublicKey(cheapest.seller.length >= 32 ? cheapest.seller : wallet.publicKey),
        amount: cheapest.askPriceUsd, noteSizeUsd: cheapest.noteSizeUsd, creditLineId: cheapest.creditLineId,
      });
      const res = await fetch(`${API}/api/exchange/buy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId: cheapest.id, buyer: wallet.publicKey.toBase58(), settlementId: env.envelope.settlementId }),
      });
      const data = await res.json();
      if (!res.ok) { addLog(`Buy failed: ${data.error}`); setBusy(false); return; }
      addLog(`✓ Filled ${data.trade.id} — shielded ${data.trade.settlementId}`);
      await refresh();
    } catch (e: any) { addLog(`Buy failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, marketListings, addLog, refresh]);

  void buyNotes;

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="border-b border-line">
        <div className="max-w-[1840px] mx-auto px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-lg font-bold">Mute</Link>
            <div className="flex gap-1">
              <Link href="/" className="px-3 py-1.5 text-xs text-muted hover:text-ink transition-colors">Dashboard</Link>
              <Link href="/trade" className="px-3 py-1.5 text-xs text-muted hover:text-ink transition-colors">Trade</Link>
              <span className="px-3 py-1.5 text-xs font-medium text-red border-b-2 border-red">Exchange</span>
            </div>
          </div>
          <span suppressHydrationWarning><WalletMultiButtonDynamic /></span>
        </div>
      </div>

      <div className="max-w-[1840px] mx-auto px-5 py-4">
        {/* Market ticker bar */}
        <div className="flex gap-2 mb-4 overflow-x-auto pb-1">
          {markets.map(m => (
            <button key={m.symbol} onClick={() => setActiveMarket(m.symbol)}
              className={`px-3 py-2 rounded-lg border whitespace-nowrap text-left transition-colors ${activeMarket === m.symbol ? "border-red bg-paper" : "border-line bg-paper hover:border-red/40"}`}>
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold">{m.symbol}</span>
                <span className={`text-[10px] mono ${m.change24hBps >= 0 ? "text-green" : "text-red"}`}>
                  {m.change24hBps >= 0 ? "▲" : "▼"} {(m.lastPrice * 100).toFixed(2)}
                </span>
              </div>
              <span className="text-[9px] mono text-muted">Vol ${(m.volume24hUsd / 1000).toFixed(0)}k</span>
            </button>
          ))}
        </div>

        {/* Top row: chart + order book */}
        <div className="grid grid-cols-1 lg:grid-cols-[1fr_280px] gap-4 mb-4">
          {/* Chart */}
          <div className="card p-4">
            {currentMarket && (
              <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
                <div className="flex items-center gap-4">
                  <h2 className="text-lg font-bold">{currentMarket.symbol}</h2>
                  <span className="text-xl font-bold mono">{(currentMarket.lastPrice * 100).toFixed(2)}</span>
                  <span className={`text-sm mono ${currentMarket.change24hBps >= 0 ? "text-green" : "text-red"}`}>
                    {currentMarket.change24hBps >= 0 ? "+" : ""}{(currentMarket.change24hBps / 100).toFixed(2)}%
                  </span>
                </div>
                <div className="flex gap-4 text-[11px] mono text-muted">
                  <span>24h H <span className="text-ink">{(currentMarket.high24h * 100).toFixed(2)}</span></span>
                  <span>24h L <span className="text-ink">{(currentMarket.low24h * 100).toFixed(2)}</span></span>
                  <span>24h Vol <span className="text-ink">${(currentMarket.volume24hUsd / 1000).toFixed(1)}k</span></span>
                </div>
              </div>
            )}
            <CandleChart candles={candles} />
            <p className="text-[10px] mono text-muted mt-1">Price = % of note face value (par = 100). Lower = bigger discount = higher yield. Hourly candles.</p>
          </div>

          {/* Order book */}
          <div className="card overflow-hidden">
            <div className="px-3 py-2 border-b border-line"><span className="mono text-[10px] text-muted uppercase">Order Book — {activeMarket}</span></div>
            <div className="grid grid-cols-3 px-3 py-1 text-[9px] mono text-muted uppercase border-b border-line/50">
              <span>Price</span><span className="text-right">Notes</span><span className="text-right">Total</span>
            </div>
            {/* Asks (reversed: highest at top) */}
            <div className="px-1 max-h-[120px] overflow-y-auto">
              {[...(book?.asks ?? [])].reverse().map((lv, i) => {
                const depthPct = Math.min(100, (lv.notes / Math.max(1, lv.total)) * 100);
                return <div key={`a${i}`} className="relative grid grid-cols-3 px-2 py-0.5 text-[11px] mono">
                  <div className="absolute right-0 top-0 h-full bg-red/8" style={{ width: `${depthPct}%` }} />
                  <span className="text-red relative">{(lv.priceBps / 100).toFixed(2)}</span>
                  <span className="text-right relative">{lv.notes}</span>
                  <span className="text-right relative text-muted">{lv.total}</span>
                </div>;
              })}
            </div>
            {/* Spread / last */}
            <div className="px-3 py-1.5 border-y border-line bg-bg mono text-[11px] flex justify-between">
              <span className="text-muted">Last</span>
              <span className="font-bold">{currentMarket ? (currentMarket.lastPrice * 100).toFixed(2) : "—"}</span>
            </div>
            {/* Bids */}
            <div className="px-1 max-h-[120px] overflow-y-auto">
              {(book?.bids ?? []).map((lv, i) => {
                const depthPct = Math.min(100, (lv.notes / Math.max(1, lv.total)) * 100);
                return <div key={`b${i}`} className="relative grid grid-cols-3 px-2 py-0.5 text-[11px] mono">
                  <div className="absolute right-0 top-0 h-full bg-green/8" style={{ width: `${depthPct}%` }} />
                  <span className="text-green relative">{(lv.priceBps / 100).toFixed(2)}</span>
                  <span className="text-right relative">{lv.notes}</span>
                  <span className="text-right relative text-muted">{lv.total}</span>
                </div>;
              })}
            </div>
          </div>
        </div>

        {/* Bottom row: trade panel + listings + trades */}
        <div className="grid grid-cols-1 lg:grid-cols-[300px_1fr_320px] gap-4">
          {/* Buy/Sell panel */}
          <div className="card p-4">
            <div className="flex gap-1 mb-3">
              <button onClick={() => setSide("buy")} className={`flex-1 py-2 text-sm font-bold rounded ${side === "buy" ? "bg-green text-paper" : "bg-bg text-muted"}`}>Buy</button>
              <button onClick={() => setSide("sell")} className={`flex-1 py-2 text-sm font-bold rounded ${side === "sell" ? "bg-red text-paper" : "bg-bg text-muted"}`}>Sell</button>
            </div>
            {!connected ? (
              <p className="text-xs text-muted py-6 text-center">Connect wallet to trade.</p>
            ) : side === "buy" ? (
              <>
                <p className="text-xs text-muted mb-3">Fills the cheapest active ask in {activeMarket}. Settlement is shielded (AES-256-GCM).</p>
                {(() => {
                  const cheapest = [...marketListings].sort((a, b) => a.askPriceUsd - b.askPriceUsd)[0];
                  return cheapest ? (
                    <div className="bg-bg rounded p-2 mb-3 mono text-xs space-y-1">
                      <div className="flex justify-between"><span className="text-muted">Best ask</span><span>${cheapest.askPriceUsd.toLocaleString()}</span></div>
                      <div className="flex justify-between"><span className="text-muted">Notes</span><span>{cheapest.noteCount}</span></div>
                      <div className="flex justify-between"><span className="text-muted">Discount</span><span className="text-red">{(cheapest.discountBps / 100).toFixed(2)}%</span></div>
                      <div className="flex justify-between"><span className="text-muted">Yield</span><span className="text-green">{(cheapest.yieldBps / 100).toFixed(1)}%</span></div>
                    </div>
                  ) : <p className="text-xs text-muted mb-3">No active asks in this market.</p>;
                })()}
                <button onClick={handleBuy} disabled={busy || marketListings.length === 0} className="w-full py-2.5 rounded bg-green text-paper text-sm font-bold disabled:opacity-30">
                  {busy ? "Processing…" : marketListings.length === 0 ? "No asks" : "Buy Now"}
                </button>
              </>
            ) : (
              <>
                <label className="text-[10px] mono text-muted uppercase block mb-1">Notes to sell</label>
                <input type="number" min={1} value={noteCount} onChange={e => setNoteCount(Math.max(1, Number(e.target.value)))} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono mb-2" />
                <label className="text-[10px] mono text-muted uppercase block mb-1">Price (% of par {noteSizeUsd > 0 ? `· $${noteSizeUsd}/note` : ""})</label>
                <input type="number" min={1} max={100} step={0.5} value={pricePct} onChange={e => setPricePct(Number(e.target.value))} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono mb-2" />
                <label className="text-[10px] mono text-muted uppercase block mb-1">Privacy</label>
                <select value={privacy} onChange={e => setPrivacy(e.target.value as PrivacyPolicyLabel)} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono mb-3">
                  {PRIVACY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                </select>
                <div className="bg-bg rounded p-2 mb-3 mono text-xs space-y-1">
                  <div className="flex justify-between"><span className="text-muted">Face</span><span>${sellFaceValue.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Ask</span><span className="text-green">${sellAskPrice.toLocaleString()}</span></div>
                  <div className="flex justify-between"><span className="text-muted">Discount</span><span className="text-red">{(sellDiscountBps / 100).toFixed(2)}%</span></div>
                  <div className="flex justify-between"><span className="text-muted">Buyer APY</span><span className="text-green">{(sellYield / 100).toFixed(1)}%</span></div>
                </div>
                <button onClick={handleSell} disabled={busy || pricePct > 100} className="w-full py-2.5 rounded bg-red text-paper text-sm font-bold disabled:opacity-30">
                  {pricePct > 100 ? "Above par" : `Sell ${noteCount} Notes`}
                </button>
              </>
            )}
          </div>

          {/* Active asks (market listings) */}
          <div className="card overflow-hidden">
            <div className="px-4 py-2 border-b border-line flex justify-between"><span className="mono text-[10px] text-muted uppercase">Active Asks — {activeMarket}</span><span className="mono text-[10px] text-muted">{marketListings.length}</span></div>
            <table className="w-full text-xs mono">
              <thead><tr className="border-b border-line text-muted">
                <th className="px-3 py-1.5 text-left">Seller</th>
                <th className="px-3 py-1.5 text-right">Notes</th>
                <th className="px-3 py-1.5 text-right">Face</th>
                <th className="px-3 py-1.5 text-right">Ask</th>
                <th className="px-3 py-1.5 text-right">Disc%</th>
                <th className="px-3 py-1.5 text-right">APY</th>
                <th className="px-3 py-1.5 text-left">Privacy</th>
              </tr></thead>
              <tbody>
                {marketListings.length === 0 ? <tr><td colSpan={7} className="px-3 py-6 text-center text-muted">No active asks</td></tr> :
                  [...marketListings].sort((a, b) => a.askPriceUsd - b.askPriceUsd).map(l => (
                    <tr key={l.id} className="border-b border-line/40 hover:bg-paper">
                      <td className="px-3 py-1.5 text-muted">{l.seller.slice(0, 8)}…</td>
                      <td className="px-3 py-1.5 text-right">{l.noteCount}</td>
                      <td className="px-3 py-1.5 text-right">${l.faceValueUsd.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right text-green">${l.askPriceUsd.toLocaleString()}</td>
                      <td className="px-3 py-1.5 text-right text-red">{(l.discountBps / 100).toFixed(2)}</td>
                      <td className="px-3 py-1.5 text-right text-green">{(l.yieldBps / 100).toFixed(1)}</td>
                      <td className="px-3 py-1.5 text-muted">{l.privacy}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>

          {/* Recent trades + log */}
          <div className="space-y-4">
            <div className="card overflow-hidden">
              <div className="px-3 py-2 border-b border-line"><span className="mono text-[10px] text-muted uppercase">Market Trades</span></div>
              <div className="max-h-[180px] overflow-y-auto">
                {trades.length === 0 ? <p className="text-xs text-muted text-center py-4">No trades yet</p> :
                  trades.map(t => (
                    <div key={t.id} className="grid grid-cols-3 px-3 py-1 text-[11px] mono border-b border-line/30">
                      <span className="text-green">{(100 - t.discountBps / 100).toFixed(2)}</span>
                      <span className="text-right">{t.noteCount}</span>
                      <span className="text-right text-muted">${(t.priceUsd / 1000).toFixed(1)}k</span>
                    </div>
                  ))}
              </div>
            </div>
            <div className="card overflow-hidden">
              <div className="px-3 py-2 border-b border-line"><span className="mono text-[10px] text-muted uppercase">Activity</span></div>
              <div className="p-2 h-[140px] overflow-y-auto space-y-1 mono text-[11px]">
                {log.length === 0 ? <p className="text-muted text-center py-4 text-[11px]">No activity</p> :
                  log.map((l, i) => <div key={i} className="bg-bg rounded px-2 py-1">{l}</div>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

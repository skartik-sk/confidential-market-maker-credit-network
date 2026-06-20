"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
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

interface NoteListing {
  id: string;
  seller: string;
  noteCount: number;
  noteSizeUsd: number;
  faceValueUsd: number;
  askPriceUsd: number;
  discountBps: number;
  yieldBps: number;
  daysToMaturity: number;
  privacy: string;
  creditLineId: string;
  createdAt: number;
  status: string;
}

interface Trade {
  id: string;
  listingId: string;
  buyer: string;
  seller: string;
  noteCount: number;
  faceValueUsd: number;
  priceUsd: number;
  discountBps: number;
  settlementId: string;
  timestamp: number;
}

interface Stats {
  activeListings: number;
  totalNotesListed: number;
  totalFaceValueUsd: number;
  tradeCount: number;
  totalVolumeUsd: number;
  avgDiscountBps: number;
  bestYieldBps: number;
}

const PRIVACY_OPTIONS: PrivacyPolicyLabel[] = ["Public", "Umbra", "Arcium", "Umbra+Arcium", "MagicBlock"];
const API = process.env.NEXT_PUBLIC_API_URL ?? "";

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function ExchangePage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [listings, setListings] = useState<NoteListing[]>([]);
  const [trades, setTrades] = useState<Trade[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [log, setLog] = useState<string[]>([]);

  // Listing form
  const [noteCount, setNoteCount] = useState(5);
  const [noteSize, setNoteSize] = useState(1000);
  const [askPrice, setAskPrice] = useState(4850);
  const [daysToMaturity, setDaysToMaturity] = useState(30);
  const [privacy, setPrivacy] = useState<PrivacyPolicyLabel>("Umbra+Arcium");

  const connected = wallet.connected && !!wallet.publicKey;

  const addLog = useCallback((msg: string) => {
    setLog(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const [l, t, s] = await Promise.all([
        fetch(`${API}/api/exchange/listings?status=active`).then(r => r.json()),
        fetch(`${API}/api/exchange/trades?limit=10`).then(r => r.json()),
        fetch(`${API}/api/exchange/stats`).then(r => r.json()),
      ]);
      setListings(l.listings ?? []);
      setTrades(t.trades ?? []);
      setStats(s);
    } catch {
      /* network error — keep stale */
    }
  }, []);

  useEffect(() => { refresh(); const id = setInterval(refresh, 8000); return () => clearInterval(id); }, [refresh]);

  // Derived form values
  const faceValue = noteCount * noteSize;
  const discountBps = faceValue > 0 ? Math.max(0, Math.round(((faceValue - askPrice) / faceValue) * 10000)) : 0;
  const annualYield = askPrice > 0 && daysToMaturity > 0 ? Math.round(((faceValue - askPrice) / askPrice) * (365 / daysToMaturity) * 10000) : 0;

  /* List notes for sale */
  const handleList = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      if (askPrice > faceValue) { addLog("Ask price cannot exceed face value"); setBusy(false); return; }
      if (askPrice <= 0 || noteCount <= 0 || noteSize <= 0) { addLog("Invalid listing parameters"); setBusy(false); return; }
      addLog(`Listing ${noteCount} notes ($${faceValue.toLocaleString()} face) at $${askPrice.toLocaleString()}…`);
      const res = await fetch(`${API}/api/exchange/listings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          seller: wallet.publicKey.toBase58(),
          noteCount, noteSizeUsd: noteSize, askPriceUsd: askPrice,
          daysToMaturity, privacy, creditLineId: wallet.publicKey.toBase58().slice(0, 6) + "…" + wallet.publicKey.toBase58().slice(-4),
        }),
      });
      const data = await res.json();
      if (!res.ok) { addLog(`List failed: ${data.error}`); setBusy(false); return; }
      addLog(`✓ Listed ${data.listing.id} — ${discountBps / 100}% discount, ~${(annualYield / 100).toFixed(1)}% APY`);
      await refresh();
    } catch (e: any) { addLog(`List failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, noteCount, noteSize, askPrice, daysToMaturity, privacy, faceValue, discountBps, annualYield, addLog, refresh]);

  /* Buy a listing — creates a shielded settlement envelope, then fills */
  const handleBuy = useCallback(async (listing: NoteListing) => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      addLog(`Buying ${listing.id}: ${listing.noteCount} notes for $${listing.askPriceUsd.toLocaleString()}…`);
      // Create a shielded settlement envelope (real AES-256-GCM encryption).
      const envelope = await createShieldedEnvelope({
        sender: wallet.publicKey,
        recipient: new PublicKey(listing.seller.length >= 32 ? listing.seller : wallet.publicKey),
        amount: listing.askPriceUsd,
        noteSizeUsd: listing.noteSizeUsd,
        creditLineId: listing.creditLineId,
      });
      addLog(`  Shielded envelope: ${envelope.envelope.settlementId}`);
      const res = await fetch(`${API}/api/exchange/buy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          listingId: listing.id,
          buyer: wallet.publicKey.toBase58(),
          settlementId: envelope.envelope.settlementId,
        }),
      });
      const data = await res.json();
      if (!res.ok) { addLog(`Buy failed: ${data.error}`); setBusy(false); return; }
      addLog(`✓ Filled ${data.trade.id} — settlement ${data.trade.settlementId}`);
      await refresh();
    } catch (e: any) { addLog(`Buy failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, addLog, refresh]);

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="border-b border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-4 flex items-center justify-between">
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

      <div className="max-w-[1840px] mx-auto px-7 py-6">
        <div className="mb-6">
          <h1 className="text-2xl font-bold mb-1">Credit Note Exchange</h1>
          <p className="text-sm text-muted">Trade confidential credit notes at a discount to face value. Off-chain order book, shielded on-chain settlement.</p>
        </div>

        {/* Stats */}
        {stats && (
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3 mb-6">
            <StatCard label="Active Listings" value={`${stats.activeListings}`} />
            <StatCard label="Notes Listed" value={`${stats.totalNotesListed}`} />
            <StatCard label="Face Value" value={`$${(stats.totalFaceValueUsd / 1000).toFixed(0)}k`} />
            <StatCard label="Trades" value={`${stats.tradeCount}`} />
            <StatCard label="Avg Discount" value={`${(stats.avgDiscountBps / 100).toFixed(2)}%`} />
            <StatCard label="Best Yield" value={`${(stats.bestYieldBps / 100).toFixed(1)}%`} highlight />
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Order book */}
          <div className="lg:col-span-2 space-y-4">
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-line flex justify-between items-center">
                <h3 className="font-bold">Active Listings</h3>
                <button onClick={refresh} className="text-xs text-muted hover:text-red">↻ Refresh</button>
              </div>
              <table className="w-full text-xs mono">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="px-4 py-2 text-left">Seller</th>
                    <th className="px-4 py-2 text-right">Notes</th>
                    <th className="px-4 py-2 text-right">Face</th>
                    <th className="px-4 py-2 text-right">Ask</th>
                    <th className="px-4 py-2 text-right">Disc.</th>
                    <th className="px-4 py-2 text-right">APY</th>
                    <th className="px-4 py-2 text-left">Privacy</th>
                    <th className="px-4 py-2 text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {listings.length === 0 ? (
                    <tr><td colSpan={8} className="px-4 py-8 text-center text-muted">No active listings</td></tr>
                  ) : listings.map(l => (
                    <tr key={l.id} className="border-b border-line/50 hover:bg-paper">
                      <td className="px-4 py-2 text-muted">{l.seller.length > 16 ? l.seller.slice(0, 8) + "…" : l.seller}</td>
                      <td className="px-4 py-2 text-right">{l.noteCount}</td>
                      <td className="px-4 py-2 text-right">${l.faceValueUsd.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right text-green">${l.askPriceUsd.toLocaleString()}</td>
                      <td className="px-4 py-2 text-right text-red">{(l.discountBps / 100).toFixed(2)}%</td>
                      <td className="px-4 py-2 text-right text-green font-bold">{(l.yieldBps / 100).toFixed(1)}%</td>
                      <td className="px-4 py-2 text-muted">{l.privacy}</td>
                      <td className="px-4 py-2 text-right">
                        <button onClick={() => handleBuy(l)} disabled={busy || !connected}
                          className="text-[10px] px-2 py-1 rounded bg-red text-paper hover:opacity-80 disabled:opacity-30">
                          {connected ? "Buy" : "Connect"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Recent trades */}
            <div className="card overflow-hidden">
              <div className="px-5 py-3 border-b border-line"><h3 className="font-bold">Recent Trades</h3></div>
              <table className="w-full text-xs mono">
                <thead>
                  <tr className="border-b border-line text-muted">
                    <th className="px-4 py-2 text-left">Trade</th>
                    <th className="px-4 py-2 text-left">Buyer</th>
                    <th className="px-4 py-2 text-right">Notes</th>
                    <th className="px-4 py-2 text-right">Price</th>
                    <th className="px-4 py-2 text-left">Settlement</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.length === 0 ? (
                    <tr><td colSpan={5} className="px-4 py-6 text-center text-muted">No trades yet</td></tr>
                  ) : trades.map(t => (
                    <tr key={t.id} className="border-b border-line/50">
                      <td className="px-4 py-2 text-muted">{t.id}</td>
                      <td className="px-4 py-2 text-muted">{t.buyer.length > 16 ? t.buyer.slice(0, 8) + "…" : t.buyer}</td>
                      <td className="px-4 py-2 text-right">{t.noteCount}</td>
                      <td className="px-4 py-2 text-right text-green">${t.priceUsd.toLocaleString()}</td>
                      <td className="px-4 py-2 text-muted">{t.settlementId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* Right column: list form + log */}
          <div className="space-y-4">
            <div className="card p-5">
              <h3 className="font-bold mb-3">List Your Notes</h3>
              {!connected ? (
                <p className="text-xs text-muted py-4 text-center">Connect wallet to list notes for sale.</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <NumField label="Notes" value={noteCount} onChange={setNoteCount} min={1} />
                    <NumField label="Note Size $" value={noteSize} onChange={setNoteSize} min={100} step={100} />
                    <NumField label="Ask Price $" value={askPrice} onChange={setAskPrice} min={1} step={50} />
                    <NumField label="Days to Mat." value={daysToMaturity} onChange={setDaysToMaturity} min={1} max={365} />
                  </div>
                  <label className="text-[10px] mono text-muted uppercase block mb-1">Privacy Rail</label>
                  <select value={privacy} onChange={e => setPrivacy(e.target.value as PrivacyPolicyLabel)}
                    className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono mb-3">
                    {PRIVACY_OPTIONS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>
                  <div className="bg-bg rounded p-3 mb-3 space-y-1 mono text-xs">
                    <Row label="Face Value" value={`$${faceValue.toLocaleString()}`} />
                    <Row label="Discount" value={`${(discountBps / 100).toFixed(2)}%`} color={discountBps > 0 ? "text-red" : "text-muted"} />
                    <Row label="Buyer APY" value={`${(annualYield / 100).toFixed(1)}%`} color="text-green" />
                  </div>
                  <button onClick={handleList} disabled={busy || askPrice > faceValue}
                    className="btn-primary text-sm w-full disabled:opacity-30">
                    {askPrice > faceValue ? "Ask exceeds face" : `List ${noteCount} Notes`}
                  </button>
                </>
              )}
            </div>

            {/* Log */}
            <div className="card overflow-hidden">
              <div className="px-4 py-2 border-b border-line"><span className="mono text-[10px] text-muted uppercase">Activity Log</span></div>
              <div className="p-3 h-[220px] overflow-y-auto space-y-1 mono text-xs">
                {log.length === 0 ? <p className="text-muted text-center py-6 text-xs">No activity yet</p> :
                  log.map((l, i) => <div key={i} className="bg-bg rounded px-2 py-1">{l}</div>)}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function StatCard({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="card p-3">
      <p className="text-[10px] mono text-muted uppercase">{label}</p>
      <p className={`text-lg font-bold mt-1 ${highlight ? "text-green" : ""}`}>{value}</p>
    </div>
  );
}

function NumField({ label, value, onChange, min, max, step }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div>
      <label className="text-[10px] mono text-muted uppercase block mb-1">{label}</label>
      <input type="number" value={value} min={min} max={max} step={step}
        onChange={e => onChange(Number(e.target.value))}
        className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono" />
    </div>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-muted">{label}</span>
      <span className={color}>{value}</span>
    </div>
  );
}

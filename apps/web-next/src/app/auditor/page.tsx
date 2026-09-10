"use client";

/**
 * Auditor View — "proofs, never values".
 *
 * The platform's auditor role verifies ZK range proofs for confidential notes.
 * This page shows exactly what that role can observe (validity, counts, chain
 * records) and — just as importantly — what it CANNOT (note values, balances).
 * No wallet is required: an auditor is an observer, not a transactor.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

const API = process.env.NEXT_PUBLIC_API_URL ?? "";

/* ------------------------------------------------------------------ */
/*  Types (client-side views of the two feed endpoints)                */
/* ------------------------------------------------------------------ */

interface VerificationEvent {
  noteId: string;
  valid: boolean;
  at: number;
}

interface VerificationStats {
  total: number;
  valid: number;
  invalid: number;
}

interface ExchangeTrade {
  id: string;
  listingId: string;
  settlementId: string;
  noteCount: number;
  timestamp: number;
  /** Devnet tx signature of the real USDC payment that settled this trade. */
  paymentSig?: string;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function AuditorPage() {
  const [stats, setStats] = useState<VerificationStats | null>(null);
  const [recent, setRecent] = useState<VerificationEvent[]>([]);
  const [trades, setTrades] = useState<ExchangeTrade[]>([]);
  const [lastSync, setLastSync] = useState<string>("");
  const [feedError, setFeedError] = useState<string>("");

  const pollVerifications = useCallback(async () => {
    try {
      const res = await fetch(`/api/zk/verify`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      // The endpoint returns { stats }; older deployments may inline the counts.
      setStats(data.stats ?? { total: data.total ?? 0, valid: data.verified ?? 0, invalid: (data.total ?? 0) - (data.verified ?? 0) });
      setRecent(Array.isArray(data.recent) ? data.recent : []);
      setFeedError("");
      setLastSync(new Date().toLocaleTimeString());
    } catch {
      setFeedError("Verification feed unreachable (endpoint cold-starting?) — retrying…");
    }
  }, []);

  const pollTrades = useCallback(async () => {
    try {
      const res = await fetch(`${API}/api/exchange/trades?limit=10`, { cache: "no-store" });
      if (!res.ok) return; // keep stale
      const data = await res.json();
      setTrades(data.trades ?? []);
    } catch { /* keep stale */ }
  }, []);

  useEffect(() => {
    pollVerifications();
    pollTrades();
    const v = setInterval(pollVerifications, 10_000);
    const t = setInterval(pollTrades, 30_000);
    return () => { clearInterval(v); clearInterval(t); };
  }, [pollVerifications, pollTrades]);

  const validityRate = stats && stats.total > 0 ? Math.round((stats.valid / stats.total) * 100) : null;

  return (
    <div className="min-h-screen bg-bg">
      {/* Header — consistent with the app, NO wallet required */}
      <div className="border-b border-line">
        <div className="max-w-[1840px] mx-auto px-3 sm:px-7 py-4 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 sm:gap-6 min-w-0">
            <Link href="/" className="text-lg font-bold shrink-0">Mute</Link>
            <div className="flex gap-0.5 sm:gap-1">
              <Link href="/" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors whitespace-nowrap">Dashboard</Link>
              <Link href="/trade" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors whitespace-nowrap">Trade</Link>
              <Link href="/exchange" className="px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-muted hover:text-ink transition-colors whitespace-nowrap">Exchange</Link>
            </div>
          </div>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-green-soft text-green text-[10px] mono uppercase shrink-0">
            <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse" />
            Read-only
          </span>
        </div>
      </div>

      <div className="max-w-[1840px] mx-auto px-3 sm:px-7 py-6 space-y-6">
        {/* Title */}
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold">Auditor View</h1>
          <p className="text-sm text-muted mt-1">
            Proofs, never values. The platform verifies zero-knowledge range proofs and
            sees <span className="text-ink">only validity</span> — the note values stay
            encrypted end to end.
          </p>
        </div>

        {/* (a) Live verification stats */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <div className="card p-4">
            <p className="text-[10px] mono text-muted uppercase">Proofs Verified</p>
            <p className="text-xl sm:text-2xl font-bold mt-1 mono">{stats ? stats.total.toLocaleString() : "—"}</p>
          </div>
          <div className="card p-4">
            <p className="text-[10px] mono text-muted uppercase">Valid</p>
            <p className="text-xl sm:text-2xl font-bold mt-1 mono text-green">{stats ? stats.valid.toLocaleString() : "—"}</p>
          </div>
          <div className="card p-4">
            <p className="text-[10px] mono text-muted uppercase">Invalid</p>
            <p className={`text-xl sm:text-2xl font-bold mt-1 mono ${stats && stats.invalid > 0 ? "text-red" : ""}`}>{stats ? stats.invalid.toLocaleString() : "—"}</p>
          </div>
          <div className="card p-4">
            <p className="text-[10px] mono text-muted uppercase">Validity Rate</p>
            <p className="text-xl sm:text-2xl font-bold mt-1 mono">{validityRate === null ? "—" : `${validityRate}%`}</p>
          </div>
        </div>

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Recent verifications */}
          <div className="lg:col-span-2 space-y-6">
            <div className="card overflow-hidden">
              <div className="px-3 sm:px-5 py-3 border-b border-line flex items-center justify-between gap-2">
                <h3 className="font-bold text-sm">Recent Verifications</h3>
                <span className="text-[10px] mono text-muted flex items-center gap-2">
                  {feedError
                    ? <span className="text-red">{feedError}</span>
                    : <>polling /api/zk/verify · 10s{lastSync ? ` · synced ${lastSync}` : ""}</>}
                </span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs mono min-w-[480px]">
                  <thead>
                    <tr className="border-b border-line text-muted text-left">
                      <th className="px-3 sm:px-5 py-2">Note ID</th>
                      <th className="px-3 sm:px-5 py-2">Proof</th>
                      <th className="px-3 sm:px-5 py-2 text-right">Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.length === 0 ? (
                      <tr><td colSpan={3} className="px-3 sm:px-5 py-10 text-center text-muted">
                        No verifications yet — draw or trade notes to generate ZK proofs
                      </td></tr>
                    ) : recent.map((e, i) => (
                      <tr key={`${e.noteId}-${e.at}-${i}`} className="border-b border-line/50 hover:bg-paper">
                        <td className="px-3 sm:px-5 py-2 text-muted">{e.noteId.slice(0, 12)}</td>
                        <td className="px-3 sm:px-5 py-2">
                          {e.valid
                            ? <span className="text-green" title="ZK range proof valid — value is a legitimate amount in [0, 2^16), value itself hidden">✓ valid</span>
                            : <span className="text-red" title="Proof rejected — invalid or bound to a different note">✗ rejected</span>}
                        </td>
                        <td className="px-3 sm:px-5 py-2 text-right text-muted">{new Date(e.at).toLocaleTimeString()}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* (b) Recent trades — settlement records, no values */}
            <div className="card overflow-hidden">
              <div className="px-3 sm:px-5 py-3 border-b border-line flex items-center justify-between">
                <h3 className="font-bold text-sm">Recent Trades (settlement records)</h3>
                <span className="text-[10px] mono text-muted">last 10 · 30s poll</span>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs mono min-w-[560px]">
                  <thead>
                    <tr className="border-b border-line text-muted text-left">
                      <th className="px-3 sm:px-5 py-2">Time</th>
                      <th className="px-3 sm:px-5 py-2 text-right">Notes</th>
                      <th className="px-3 sm:px-5 py-2">Settlement</th>
                      <th className="px-3 sm:px-5 py-2 text-right">Chain</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trades.length === 0 ? (
                      <tr><td colSpan={4} className="px-3 sm:px-5 py-10 text-center text-muted">
                        No trades yet — fills appear here with their shielded settlement IDs
                      </td></tr>
                    ) : trades.map(t => (
                      <tr key={t.id} className="border-b border-line/50 hover:bg-paper">
                        <td className="px-3 sm:px-5 py-2 text-muted">{new Date(t.timestamp).toLocaleTimeString()}</td>
                        <td className="px-3 sm:px-5 py-2 text-right">{t.noteCount}</td>
                        <td className="px-3 sm:px-5 py-2 text-muted" title={`Shielded settlement envelope: ${t.settlementId}`}>
                          {t.settlementId.slice(0, 18)}…
                        </td>
                        <td className="px-3 sm:px-5 py-2 text-right">
                          {t.paymentSig
                            ? <a
                                href={`https://explorer.solana.com/tx/${t.paymentSig}?cluster=devnet`}
                                target="_blank" rel="noreferrer"
                                className="text-green hover:underline"
                                title={`Real USDC payment on devnet: ${t.paymentSig}`}
                              >paid ✓</a>
                            : <span className="text-muted" title="USDC payment not yet recorded on devnet">pending</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          {/* Side: what the auditor can / cannot see + honest limitations */}
          <div className="space-y-4">
            {/* Explainer card */}
            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-sm mb-3">What the auditor sees</h3>
              <div className="space-y-4">
                <div className="rounded-lg border border-green/30 bg-green-soft p-3">
                  <p className="text-[10px] mono uppercase text-green mb-2">CAN verify</p>
                  <ul className="text-xs space-y-1.5 text-ink">
                    <li>• Each note&apos;s ZK range proof is <span className="text-green">valid</span></li>
                    <li>• Counts: how many proofs, how many passed</li>
                    <li>• Truncated note IDs and verification times</li>
                    <li>• On-chain records: settlements, payment txs, commitments</li>
                  </ul>
                </div>
                <div className="rounded-lg border border-red/30 bg-red-soft p-3">
                  <p className="text-[10px] mono uppercase text-red mb-2">CANNOT see</p>
                  <ul className="text-xs space-y-1.5 text-ink">
                    <li>• Note values — proven in ZK, never transmitted</li>
                    <li>• Wallet balances or credit utilization</li>
                    <li>• Trade amounts, prices or exposure</li>
                    <li>• Who owns what (stealth settlement envelopes)</li>
                  </ul>
                </div>
                <p className="text-[11px] text-muted leading-relaxed">
                  Range proofs constrain every note value to a legitimate integer in
                  <span className="mono"> [0, 2<sup>16</sup>)</span> without revealing it — the
                  verifier learns <span className="text-ink">&quot;in range: yes/no&quot;</span> and nothing else.
                </p>
              </div>
            </div>

            {/* (c) Honest limitation note */}
            <div className="card p-4 sm:p-5 border-red/30">
              <h3 className="font-bold text-sm mb-2 text-red">Honest limitation</h3>
              <p className="text-[11px] text-muted leading-relaxed">
                These verification stats are held <span className="text-ink">in memory</span> in
                the API process. On serverless infrastructure a cold start resets the feed to
                zero — counts here are live telemetry for this instance, not durable history.
                The proofs themselves remain independently verifiable; only this convenience
                view is ephemeral.
              </p>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold text-sm mb-2">Scope</h3>
              <p className="text-[11px] text-muted leading-relaxed">
                Read-only view. No wallet connection, no transaction authority — an auditor
                observes proofs and chain records but cannot move funds, draw credit, or
                settle trades.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

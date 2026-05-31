"use client";

import { useState, useEffect, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface Note { id: string; sizeUsd: number; status: string; market?: string }
interface CreditLine {
  id: string; borrower: string; noteSizeUsd: number; limitNotes: number;
  drawnNotes: number; repaidNotes: number; defaultedNotes: number;
  totalCreditUsd: number; totalDrawnUsd: number; totalRepaidUsd: number;
  outstandingUsd: number; outstandingNotes: number;
  collateral: { asset: string; deposited: number; required: number; healthRatio: number; status: string };
  notes: Note[];
  creditLines: { id: string; noteSize: number; notes: number; total: number; drawn: number; repaid: number; status: string }[];
}
interface PrivacyOption { id: string; label: string; status: "working" | "external-rail" | "native-guarded"; implementedInThisRepo: boolean; bestFor: string; whatItHides: string[] }
interface RiskResult { input: { inventoryUsd: number; exposureUsd: number; drawdownBps: number; venueCount: number }; result: { passed: boolean; riskScoreBps: number; commitmentHash: string } }
interface SettlementData {
  draw: { envelope: { settlementId: string; noteDelta: number; commitment: string }; receipt: { verified: boolean; receiptHash: string }; noteValue: number };
  repay: { envelope: { settlementId: string; noteDelta: number; commitment: string }; receipt: { verified: boolean; receiptHash: string }; noteValue: number };
  verified: { drawDecryptedOk: boolean; drawReceiptValid: boolean; repayReceiptValid: boolean };
  noteSummary: { totalNotes: number; drawnCount: number; repaidCount: number; drawnValueUsd: number; repaidValueUsd: number; noteSize: number };
}
interface OnChainState { live: boolean; executable?: boolean; dataLength?: number; lamports?: number; slot?: number; programId: string; deployTx?: string; explorer?: string }

const API = process.env.NEXT_PUBLIC_API_URL ?? "";
async function get<T>(p: string): Promise<T | null> { try { const r = await fetch(`${API}${p}`); return r.ok ? r.json() : null; } catch { return null; } }

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Dashboard({ realAppSlot }: { realAppSlot?: React.ReactNode }) {
  const [credit, setCredit] = useState<CreditLine | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyOption[]>([]);
  const [risk, setRisk] = useState<RiskResult | null>(null);
  const [settlement, setSettlement] = useState<SettlementData | null>(null);
  const [onchain, setOnchain] = useState<OnChainState | null>(null);
  const [ready, setReady] = useState(false);
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    (async () => {
      const [c, p, r, s, o] = await Promise.all([
        get<CreditLine>("/api/demo/credit-line"),
        get<{ options: PrivacyOption[] }>("/api/demo/privacy-options"),
        get<RiskResult>("/api/demo/risk-compute"),
        get<SettlementData>("/api/demo/settlement"),
        get<OnChainState>("/api/onchain/state"),
      ]);
      if (c) setCredit(c);
      if (p) setPrivacy(p.options);
      if (r) setRisk(r);
      if (s) setSettlement(s);
      if (o) setOnchain(o);
      setReady(true);
    })();
  }, []);

  const play = useCallback(() => { if (credit) { setStep(0); setRunning(true); } }, [credit]);
  useEffect(() => { if (!running) return; const iv = setInterval(() => { setStep(p => { if (p >= 6) { setRunning(false); return p; } return p + 1; }); }, 900); return () => clearInterval(iv); }, [running]);

  const act = async (id: string) => {
    setBusy(true);
    const t0 = Date.now();
    let msg: string;
    if (id === "apply") { const d = await get<CreditLine>("/api/demo/credit-line"); msg = d ? `Approved: ${d.limitNotes} notes × $${d.noteSizeUsd.toLocaleString()} = $${d.totalCreditUsd.toLocaleString()} credit` : "Failed"; }
    else if (id === "collateral") { const d = await get<{ deposited: number; healthRatio: number }>("/api/demo/collateral"); msg = d ? `Collateral: $${d.deposited.toLocaleString()} USDC locked (health: ${d.healthRatio}x)` : "Failed"; }
    else if (id === "draw") { msg = settlement ? `Draw: 1 note ($${settlement.noteSummary.noteSize.toLocaleString()}) → ${settlement.draw.envelope.settlementId}` : "No data"; }
    else if (id === "risk") { msg = risk ? `MPC Risk: ${risk.result.riskScoreBps}bps — ${risk.result.passed ? "PASSED" : "FAILED"}` : "No data"; }
    else if (id === "repay") { msg = settlement ? `Repay: 1 note ($${settlement.noteSummary.noteSize.toLocaleString()}) → ${settlement.repay.envelope.settlementId}` : "No data"; }
    else { msg = settlement ? `Verified: draw=${settlement.verified.drawReceiptValid} repay=${settlement.verified.repayReceiptValid}` : "No data"; }
    setLogs(prev => [`[${Date.now() - t0}ms] ${msg}`, ...prev].slice(0, 20));
    setBusy(false);
  };

  if (!ready) return (
    <div className="flex items-center justify-center min-h-screen bg-bg">
      <div className="text-center animate-fade">
        <div className="w-8 h-8 border-2 border-red border-t-transparent rounded-full animate-spin mx-auto mb-4" />
        <p className="mono text-xs text-muted">Connecting to devnet...</p>
      </div>
    </div>
  );

  const steps = credit ? [
    { t: "Apply", d: "Borrower submits encrypted application", o: { borrower: credit.borrower, id: credit.id } },
    { t: "Collateral", d: "Lock USDC as collateral", o: { deposited: `$${credit.collateral.deposited.toLocaleString()}`, health: `${credit.collateral.healthRatio}x`, status: credit.collateral.healthRatio > 1.5 ? "healthy" : "at risk" } },
    { t: "Draw", d: `Draw notes ($${credit.noteSizeUsd.toLocaleString()} each)`, o: { notes: `${credit.drawnNotes} drawn`, perNote: `$${credit.noteSizeUsd.toLocaleString()}`, total: `$${credit.totalDrawnUsd.toLocaleString()}`, ...(settlement ? { envelope: settlement.draw.envelope.settlementId } : {}) } },
    { t: "Risk Check", d: "Encrypted MPC scoring", o: risk ? { score: `${risk.result.riskScoreBps}bps`, passed: risk.result.passed ? "YES" : "NO", commitment: risk.result.commitmentHash } : { status: "computing" } },
    { t: "Repay", d: "Repay with shielded envelope", o: { repaid: `${credit.repaidNotes} notes`, value: `$${credit.totalRepaidUsd.toLocaleString()}` } },
    { t: "Receipt", d: "Auditor posts commitment hash", o: { hash: "receipt_a8f3b2c1", signer: "AUD-DEMO-01" } },
    { t: "Settle", d: "Vault closes the loop", o: { outstanding: `${credit.outstandingNotes} notes ($${credit.outstandingUsd.toLocaleString()})`, defaulted: "0" } },
  ] : [];

  const current = steps[step];

  return (
    <div className="min-h-screen bg-bg text-ink">
      {/* NAV */}
      <nav className="sticky top-0 z-50 border-b border-line bg-paper/80 backdrop-blur-xl">
        <div className="max-w-[1840px] mx-auto px-7 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-[30px] h-[30px] border border-line rounded-lg bg-paper relative">
              <div className="absolute inset-2 rotate-45" style={{ background: "#dc2b28", borderRadius: "2px" }} />
            </div>
            <span className="font-bold text-lg">credit-vault</span>
            {onchain?.live && <span className="text-[10px] mono px-2 py-0.5 rounded-full state-pill animate-glow">DEVNET LIVE</span>}
          </div>
          <div className="flex items-center gap-6 text-sm text-muted">
            <a href="#how" className="hover:text-ink transition-colors">How it works</a>
            <a href="#execute" className="hover:text-ink transition-colors">Execute</a>
            <a href="#privacy" className="hover:text-ink transition-colors">Privacy</a>
            <a href="#verify" className="hover:text-ink transition-colors">Verify</a>
          </div>
        </div>
      </nav>

      {/* HERO */}
      <section className="max-w-[1840px] mx-auto px-7 pt-16 pb-12">
        <div className="animate-fade">
          <div className="inline-flex items-center gap-2 text-xs mono px-3 py-1 rounded border border-red/30 bg-red-soft text-red mb-6">
            <span className="w-1.5 h-1.5 rounded-full bg-red animate-pulse" />
            {onchain?.live ? "verified on devnet" : "verified local proof"}
          </div>
          <h1 className="text-5xl md:text-7xl font-normal leading-none tracking-tight mb-6" style={{ fontFamily: "var(--font-geist-mono)" }}>
            Credit lines that<br /><span className="text-red">settle quietly.</span>
          </h1>
          <p className="text-muted text-lg max-w-xl leading-relaxed mb-8">
            Confidential operating credit for Solana market makers. Fixed-value notes, encrypted risk checks, and shielded settlement — without exposing every input.
          </p>
          <div className="flex gap-3 mb-12">
            <button onClick={play} className="btn-primary text-sm">Run Credit Flow</button>
            <a href="/api/demo/protocol" className="btn-ghost text-sm">Protocol Manifest</a>
          </div>

          {/* Stats — meaningful platform metrics */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-0 border border-line rounded-xl overflow-hidden max-w-[900px]">
            {[
              { n: credit ? `$${(credit.totalCreditUsd / 1000).toFixed(0)}K` : "$50K", l: "Credit Available" },
              { n: credit ? `$${credit.noteSizeUsd.toLocaleString()}` : "$1,000", l: "Per Note" },
              { n: "5", l: "Privacy Rails" },
              { n: credit ? `$${(credit.collateral.deposited / 1000).toFixed(0)}K` : "$100K", l: "Total Locked" },
              { n: "2", l: "Active Markets" },
            ].map(s => (
              <div key={s.l} className="bg-paper p-5 text-center border-r border-line last:border-r-0">
                <p className="stat-num text-ink">{s.n}</p>
                <p className="mono text-[10px] text-muted uppercase mt-1">{s.l}</p>
              </div>
            ))}
          </div>

          {/* On-chain verification */}
          {onchain?.live && (
            <div className="mt-8 card p-4 space-y-2 max-w-[900px]">
              <div className="flex items-center gap-3">
                <div className="w-2 h-2 rounded-full bg-green animate-glow" />
                <span className="mono text-xs text-green">Program verified on-chain</span>
              </div>
              <div className="flex items-center gap-4 mono text-xs text-muted">
                <span>Executable: {onchain.executable ? "✓" : "✗"}</span>
                <span>Binary: {onchain.dataLength ? `${(onchain.dataLength / 1024).toFixed(0)}KB` : "?"}</span>
                <span>Lamports: {onchain.lamports?.toLocaleString()}</span>
                {onchain.slot && <span>Slot: {onchain.slot.toLocaleString()}</span>}
              </div>
              <div className="flex items-center gap-3">
                <span className="mono text-[10px] text-muted truncate">{onchain.programId}</span>
                <a href={onchain.explorer} target="_blank" rel="noopener noreferrer" className="mono text-xs text-red hover:underline ml-auto">Explorer →</a>
                {onchain.deployTx && <a href={`https://explorer.solana.com/tx/${onchain.deployTx}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="mono text-xs text-red hover:underline">Deploy TX →</a>}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* REAL APP — connect wallet & interact with devnet program */}
      {realAppSlot && (
        <section className="border-t border-line">
          <div className="max-w-[1840px] mx-auto px-7 py-4">
            <p className="section-tag mb-3">Live on Devnet</p>
            <h2 className="text-4xl font-bold tracking-tight mb-6">Interact with the program.</h2>
          </div>
          {realAppSlot}
        </section>
      )}

      {/* HOW IT WORKS */}
      <section id="how" className="border-t border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-16">
          <p className="section-tag mb-3">Mechanics</p>
          <h2 className="text-4xl font-bold tracking-tight mb-12">How it works.</h2>

          <div className="grid md:grid-cols-3 gap-6 mb-12">
            {[
              { num: "01", title: "Deposit Collateral", desc: `Lock USDC as collateral into the vault. Underwriter approves a credit line with a fixed note value. Health ratio must stay above 1.5x — if it drops, the line gets paused.` },
              { num: "02", title: `Draw Notes ($${credit?.noteSizeUsd.toLocaleString() ?? "1,000"} each)`, desc: `Draw notes of a fixed value. For example: $6,000 credit → 4 notes × $1,500 each. Simple, transparent accounting with private settlement.` },
              { num: "03", title: "Settle & Verify", desc: "Repay notes. Auditor posts commitment hashes. All receipts verified on-chain. Unpaid notes are marked DEFAULTED permanently." },
            ].map(s => (
              <div key={s.num} className="card p-6">
                <span className="step-num">Step {s.num}</span>
                <h3 className="font-bold text-lg mt-4 mb-2">{s.title}</h3>
                <p className="text-muted text-sm leading-relaxed">{s.desc}</p>
              </div>
            ))}
          </div>

          {/* Collateral detail */}
          {credit?.collateral && (
            <div className="card p-6">
              <h3 className="font-bold mb-4">Collateral Status</h3>
              <div className="grid grid-cols-4 gap-4 mono text-xs">
                <div className="bg-bg rounded p-3">
                  <p className="text-muted text-[10px] uppercase">Deposited</p>
                  <p className="text-green mt-1">${credit.collateral.deposited.toLocaleString()}</p>
                </div>
                <div className="bg-bg rounded p-3">
                  <p className="text-muted text-[10px] uppercase">Required</p>
                  <p className="mt-1">${credit.collateral.required.toLocaleString()}</p>
                </div>
                <div className="bg-bg rounded p-3">
                  <p className="text-muted text-[10px] uppercase">Health</p>
                  <p className={credit.collateral.healthRatio > 1.5 ? "text-green mt-1" : "text-red mt-1"}>{credit.collateral.healthRatio}x</p>
                </div>
                <div className="bg-bg rounded p-3">
                  <p className="text-muted text-[10px] uppercase">Status</p>
                  <p className="text-green mt-1">Healthy</p>
                </div>
              </div>
            </div>
          )}
        </div>
      </section>

      {/* CREDIT LINES — shows how different users get different note sizes */}
      {credit?.creditLines && (
        <section className="border-t border-line">
          <div className="max-w-[1840px] mx-auto px-7 py-16">
            <p className="section-tag mb-3">Credit Lines</p>
            <h2 className="text-4xl font-bold tracking-tight mb-4">Your active lines.</h2>
            <p className="text-muted text-sm max-w-lg mb-8">Each credit line has a fixed note value. The note size is set when you apply — $1,000/note, $1,500/note, $3,000/note — based on your needs.</p>

            <div className="grid md:grid-cols-3 gap-4">
              {credit.creditLines.map(line => (
                <div key={line.id} className="card p-5">
                  <div className="flex items-center justify-between mb-3">
                    <span className="mono text-[10px] text-muted">{line.id}</span>
                    <span className="text-[10px] mono px-2 py-0.5 rounded-full bg-green-soft text-green border border-green/20">{line.status}</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mono text-xs">
                    <div>
                      <p className="text-muted text-[10px] uppercase">Note Size</p>
                      <p className="font-bold text-lg">${line.noteSize.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-muted text-[10px] uppercase">Total Credit</p>
                      <p className="font-bold text-lg">${line.total.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-muted text-[10px] uppercase">Notes</p>
                      <p className="mt-0.5">{line.notes} × ${line.noteSize.toLocaleString()}</p>
                    </div>
                    <div>
                      <p className="text-muted text-[10px] uppercase">Drawn / Repaid</p>
                      <p className="mt-0.5"><span className="text-red">{line.drawn}</span> / <span className="text-green">{line.repaid}</span></p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </section>
      )}

      {/* NOTES — individual notes for active line */}
      {credit?.notes && (
        <section className="border-t border-line">
          <div className="max-w-[1840px] mx-auto px-7 py-16">
            <p className="section-tag mb-3">Active Notes</p>
            <h2 className="text-4xl font-bold tracking-tight mb-4">Line: {credit.id}</h2>
            <p className="text-muted text-sm max-w-lg mb-8">Each note is worth ${credit.noteSizeUsd.toLocaleString()}. Drawn notes are active in the market; repaid notes are settled.</p>

            <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
              {credit.notes.map(n => (
                <div key={n.id} className={`card p-3 text-center ${n.status === "drawn" ? "border-red/20" : n.status === "repaid" ? "border-green/20" : ""}`}>
                  <p className="mono text-[10px] text-muted">{n.id}</p>
                  <p className={`font-bold text-lg ${n.status === "drawn" ? "text-red" : "text-green"}`}>${n.sizeUsd.toLocaleString()}</p>
                  <p className={`mono text-[10px] ${n.status === "drawn" ? "text-red/60" : "text-green/60"}`}>{n.status}</p>
                  {n.market && <p className="mono text-[10px] text-muted mt-1">{n.market}</p>}
                </div>
              ))}
            </div>

            <div className="mt-6 grid grid-cols-3 gap-4 mono text-xs max-w-[600px]">
              <div className="bg-bg rounded p-3 text-center">
                <p className="text-muted text-[10px] uppercase">Drawn Value</p>
                <p className="text-red mt-1">${credit.totalDrawnUsd.toLocaleString()}</p>
              </div>
              <div className="bg-bg rounded p-3 text-center">
                <p className="text-muted text-[10px] uppercase">Repaid Value</p>
                <p className="text-green mt-1">${credit.totalRepaidUsd.toLocaleString()}</p>
              </div>
              <div className="bg-bg rounded p-3 text-center">
                <p className="text-muted text-[10px] uppercase">Outstanding</p>
                <p className="mt-1">${credit.outstandingUsd.toLocaleString()}</p>
              </div>
            </div>
          </div>
        </section>
      )}

      {/* CREDIT FLOW */}
      <section className="border-t border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-16">
          <p className="section-tag mb-3">Showcase</p>
          <h2 className="text-4xl font-bold tracking-tight mb-12">Follow the credit path.</h2>
          <div className="grid lg:grid-cols-5 gap-6">
            <div className="lg:col-span-2 space-y-1.5">
              {steps.map((s, i) => (
                <button key={i} onClick={() => { setStep(i); setRunning(false); }} className={`w-full text-left px-4 py-3 rounded-lg border transition-all text-sm ${i === step ? "bg-red/5 border-red/30" : i < step ? "bg-green/5 border-green/10" : "bg-paper border-line"}`}>
                  <div className="flex items-center gap-3">
                    <span className={`mono text-[11px] w-6 ${i === step ? "text-red" : "text-muted"}`}>{String(i + 1).padStart(2, "0")}</span>
                    <div className="flex-1"><p className={`font-medium ${i === step ? "text-ink" : "text-muted"}`}>{s.t}</p></div>
                    {i < step && <span className="text-green text-xs">✓</span>}
                  </div>
                </button>
              ))}
            </div>
            <div className="lg:col-span-3">
              {current && (
                <div key={step} className="bg-paper rounded-xl border border-line p-6 animate-fade">
                  <div className="flex items-center gap-3 mb-4">
                    <span className="step-num">Step {String(step + 1).padStart(2, "0")}</span>
                    <h3 className="font-bold text-lg">{current.t}</h3>
                  </div>
                  <p className="text-muted text-sm mb-4">{current.d}</p>
                  <div className="bg-bg rounded-lg p-4 mono text-xs space-y-2">
                    {Object.entries(current.o).map(([k, v]) => (
                      <div key={k} className="flex gap-3"><span className="text-muted min-w-[90px]">{k}</span><span className="text-red break-all">{v}</span></div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </section>

      {/* EXECUTE */}
      <section id="execute" className="border-t border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-16">
          <p className="section-tag mb-3">Execute</p>
          <h2 className="text-4xl font-bold tracking-tight mb-12">Run the live cycle.</h2>
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="space-y-2">
              {[
                { id: "apply", label: "Apply for Credit Line", desc: "Load encrypted deal room" },
                { id: "collateral", label: "Check Collateral", desc: "Verify USDC deposit" },
                { id: "draw", label: "Draw Notes", desc: "Shielded settlement" },
                { id: "risk", label: "Run MPC Risk Compute", desc: "Encrypted scoring" },
                { id: "repay", label: "Repay Notes", desc: "Shielded envelope" },
                { id: "settle", label: "Verify Settlement", desc: "Receipt verification" },
              ].map(a => (
                <button key={a.id} onClick={() => act(a.id)} disabled={busy} className="w-full text-left px-5 py-4 rounded-xl bg-paper border border-line hover:border-red/30 hover:bg-red/5 transition-all group disabled:opacity-40">
                  <div className="flex items-center justify-between">
                    <div><p className="font-medium text-sm group-hover:text-red transition-colors">{a.label}</p><p className="text-[11px] text-muted mt-0.5">{a.desc}</p></div>
                    <span className="text-muted text-xs group-hover:text-red transition-colors">→</span>
                  </div>
                </button>
              ))}
            </div>
            <div className="bg-paper rounded-xl border border-line overflow-hidden">
              <div className="px-4 py-3 border-b border-line flex justify-between">
                <span className="mono text-[10px] text-muted uppercase">Execution Log</span>
                <span className="mono text-[10px] text-muted">{logs.length}</span>
              </div>
              <div className="p-4 h-[380px] overflow-y-auto space-y-1.5 mono text-xs">
                {logs.length === 0 ? <p className="text-muted text-center py-8">Click an action to execute</p> :
                  logs.map((l, i) => <div key={i} className="bg-bg rounded px-3 py-2 animate-slide" style={{ animationDelay: `${i * 30}ms` }}>{l}</div>)}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* PRIVACY */}
      <section id="privacy" className="border-t border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-16">
          <p className="section-tag mb-3">Privacy</p>
          <h2 className="text-4xl font-bold tracking-tight mb-12">Privacy rails.</h2>
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            {privacy.map(p => (
              <div key={p.id} className={`card p-5 ${p.status === "native-guarded" ? "opacity-60 border-dashed" : ""}`}>
                <div className="flex items-center justify-between mb-3">
                  <span className={`mono text-[10px] px-2 py-0.5 rounded-full ${p.status === "working" ? "bg-green-soft text-green" : "bg-amber-soft text-amber"}`}>{p.status === "working" ? "WORKING" : "GUARDED"}</span>
                  {p.implementedInThisRepo && <span className="mono text-[10px] text-red">in repo</span>}
                </div>
                <h3 className="font-bold mb-1">{p.label}</h3>
                <p className="text-muted text-xs leading-relaxed">{p.bestFor}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* VERIFY */}
      <section id="verify" className="border-t border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-16">
          <p className="section-tag mb-3">Verification</p>
          <h2 className="text-4xl font-bold tracking-tight mb-12">Real crypto under the hood.</h2>
          <div className="grid lg:grid-cols-2 gap-6">
            <div className="bg-paper rounded-xl border border-line overflow-hidden">
              <div className="px-5 py-3 border-b border-line"><h3 className="font-bold text-sm">MPC Risk Compute</h3></div>
              {risk ? (
                <div className="p-5 space-y-4">
                  <div className="flex items-center gap-3">
                    <div className={`w-3 h-3 rounded-full ${risk.result.passed ? "bg-green" : "bg-red"}`} />
                    <span className="font-bold">{risk.result.passed ? "PASSED" : "FAILED"}</span>
                    <span className="mono text-xs text-muted ml-auto">{risk.result.riskScoreBps} bps</span>
                  </div>
                  <div className="grid grid-cols-2 gap-3 mono text-xs">
                    {[{ l: "Inventory", v: `$${risk.input.inventoryUsd.toLocaleString()}` }, { l: "Exposure", v: `$${risk.input.exposureUsd.toLocaleString()}` }, { l: "Drawdown", v: `${risk.input.drawdownBps} bps` }, { l: "Venues", v: `${risk.input.venueCount}` }].map(d => (
                      <div key={d.l} className="bg-bg rounded p-2.5"><p className="text-muted text-[10px] uppercase">{d.l}</p><p className="mt-0.5">{d.v}</p></div>
                    ))}
                  </div>
                  <div className="bg-bg rounded p-3 mono text-xs"><p className="text-muted text-[10px] uppercase">Commitment</p><p className="text-red mt-1 break-all">{risk.result.commitmentHash}</p></div>
                </div>
              ) : <div className="p-8 text-center text-muted text-sm">Unavailable</div>}
            </div>
            <div className="bg-paper rounded-xl border border-line overflow-hidden">
              <div className="px-5 py-3 border-b border-line"><h3 className="font-bold text-sm">Shielded Settlement</h3></div>
              {settlement ? (
                <div className="p-5 space-y-4">
                  <div className="grid grid-cols-3 gap-3">
                    {[{ l: "Draw decrypt", ok: settlement.verified.drawDecryptedOk }, { l: "Draw receipt", ok: settlement.verified.drawReceiptValid }, { l: "Repay receipt", ok: settlement.verified.repayReceiptValid }].map(v => (
                      <div key={v.l} className={`rounded-lg p-3 text-center mono text-xs ${v.ok ? "bg-green-soft border border-green/20" : "bg-red-soft border border-red/20"}`}>
                        <span className={v.ok ? "text-green" : "text-red"}>{v.ok ? "✓" : "✗"}</span>
                        <p className="text-muted mt-1 text-[10px]">{v.l}</p>
                      </div>
                    ))}
                  </div>
                  {[{ label: "Draw", env: settlement.draw }, { label: "Repay", env: settlement.repay }].map(({ label, env }) => (
                    <div key={label} className="bg-bg rounded p-3 mono text-xs space-y-1">
                      <p className="text-muted text-[10px] uppercase">{label}: Note value ${env.noteValue.toLocaleString()}</p>
                      <p>ID: <span className="text-red">{env.envelope.settlementId}</span></p>
                      <p>Receipt: <span className="text-green">{env.receipt.receiptHash}</span></p>
                    </div>
                  ))}
                </div>
              ) : <div className="p-8 text-center text-muted text-sm">Unavailable</div>}
            </div>
          </div>
        </div>
      </section>

      {/* FOOTER */}
      <footer className="border-t border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-2 text-sm text-muted">
            <div className="w-5 h-5 border border-line rounded bg-paper relative">
              <div className="absolute inset-1 rotate-45" style={{ background: "#dc2b28", borderRadius: "1px" }} />
            </div>
            credit-vault — Confidential Credit on Solana
          </div>
          <div className="flex gap-4 mono text-xs text-muted">
            <a href="/api/demo/protocol" className="hover:text-red transition-colors">Protocol</a>
            <a href="/api/onchain/state" className="hover:text-red transition-colors">On-chain</a>
            <a href="/api/demo/collateral" className="hover:text-red transition-colors">Collateral</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

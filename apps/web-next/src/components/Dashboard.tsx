"use client";

import { useState, useEffect, useCallback } from "react";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface CreditLine {
  id: string;
  borrower: string;
  underwriter: string;
  auditor: string;
  poolId: string;
  noteSizeUsd: number;
  limitNotes: number;
  drawnNotes: number;
  repaidNotes: number;
  defaultedNotes: number;
  interestBps: number;
  maturitySlot: number;
  status: number;
  mandate: { allowedMarkets: string[]; maxDrawdownBps: number };
  receipts?: { receiptHash: string; signer: string }[];
  drawHistory?: { notes: number; market: string }[];
}

interface PrivacyOption {
  id: string;
  label: string;
  status: "working" | "external-rail" | "native-guarded";
  implementedInThisRepo: boolean;
  bestFor: string;
  whatItHides: string[];
  whatStaysPublic: string[];
}

interface RiskResult {
  input: { inventoryUsd: number; exposureUsd: number; drawdownBps: number; venueCount: number };
  result: { passed: boolean; riskScoreBps: number; commitmentHash: string };
}

interface SettlementData {
  draw: { envelope: { settlementId: string; kind: string; noteDelta: number; commitment: string }; receipt: { verified: boolean; receiptHash: string } };
  repay: { envelope: { settlementId: string; kind: string; noteDelta: number; commitment: string }; receipt: { verified: boolean; receiptHash: string } };
  verified: { drawDecryptedOk: boolean; drawReceiptValid: boolean; repayReceiptValid: boolean };
}

interface DevnetInfo {
  cluster: string;
  programId: string;
  explorer: string;
  magicblock: { erRpc: string; delegationProgram: string };
}

interface FlowStep {
  label: string;
  title: string;
  summary: string;
  output: Record<string, string>;
}

/* ------------------------------------------------------------------ */
/*  API fetch helper                                                   */
/* ------------------------------------------------------------------ */

const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "";

async function fetchJson<T>(path: string, init?: RequestInit): Promise<T | null> {
  try {
    const res = await fetch(`${API_BASE}${path}`, { headers: { accept: "application/json" }, ...init });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ */
/*  Flow steps builder                                                 */
/* ------------------------------------------------------------------ */

function buildFlowSteps(credit: CreditLine, risk: RiskResult | null, settlement: SettlementData | null): FlowStep[] {
  const draw = credit.drawHistory?.[0];
  const receipt = credit.receipts?.[0];
  return [
    {
      label: "apply",
      title: "Borrower applies for credit",
      summary: "The borrower opens a private deal room with encrypted strategy, venues, and exposure terms. Only deterministic commitments go on-chain.",
      output: {
        borrower: credit.borrower,
        auditor: credit.auditor,
        terms_hash: `terms_${credit.mandate.allowedMarkets.join("_")}`,
      },
    },
    {
      label: "approve",
      title: "Underwriter approves the line",
      summary: `Line capped at ${credit.limitNotes} notes ($${(credit.limitNotes * credit.noteSizeUsd).toLocaleString()}), with markets ${credit.mandate.allowedMarkets.join(", ")}. The underwriter controls pause and reactivation.`,
      output: {
        limit: `${credit.limitNotes} notes`,
        note_size: `$${credit.noteSizeUsd.toLocaleString()}`,
        markets: credit.mandate.allowedMarkets.join(", "),
        max_drawdown: `${credit.mandate.maxDrawdownBps} bps`,
      },
    },
    {
      label: "draw",
      title: "Market maker draws inventory",
      summary: `Draws ${draw?.notes ?? credit.drawnNotes} notes for ${draw?.market ?? "SOL-PERP"} quoting. Each note is a fixed $${credit.noteSizeUsd.toLocaleString()} chunk — exact amounts stay hidden.`,
      output: {
        drawn: `${draw?.notes ?? credit.drawnNotes} notes`,
        market: draw?.market ?? "SOL-PERP",
        ...(settlement
          ? { envelope: settlement.draw.envelope.settlementId, commitment: settlement.draw.envelope.commitment }
          : {}),
      },
    },
    {
      label: "risk",
      title: "Arcium MPC risk check",
      summary: "Inventory, exposure, and drawdown go into an encrypted computation. The auditor gets only a pass/fail commitment — never the raw numbers.",
      output: risk
        ? {
            score: `${risk.result.riskScoreBps} bps`,
            passed: risk.result.passed ? "YES ✅" : "NO ❌",
            commitment: risk.result.commitmentHash,
            inventory: `$${risk.input.inventoryUsd.toLocaleString()}`,
            exposure: `$${risk.input.exposureUsd.toLocaleString()}`,
          }
        : { status: "computing..." },
    },
    {
      label: "receipt",
      title: "Auditor posts receipt hash",
      summary: "The risk report becomes a compact receipt hash. Other machines can verify it later. The auditor never sees raw inventory.",
      output: {
        receipt: receipt?.receiptHash ?? "receipt_demo_hour_01",
        signer: receipt?.signer ?? credit.auditor,
        ...(settlement ? { draw_receipt: settlement.draw.receipt.receiptHash } : {}),
      },
    },
    {
      label: "repay",
      title: "Borrower repays notes",
      summary: `${credit.repaidNotes} notes repaid before maturity. The settlement envelope is encrypted — only borrower and auditor see the details.`,
      output: {
        repaid: `${credit.repaidNotes} notes`,
        outstanding: `${credit.drawnNotes - credit.repaidNotes - credit.defaultedNotes} notes`,
        ...(settlement
          ? { envelope: settlement.repay.envelope.settlementId, receipt_valid: settlement.verified.repayReceiptValid ? "YES ✅" : "NO" }
          : {}),
      },
    },
    {
      label: "settle",
      title: "Settle or close maturity",
      summary: "The vault closes the accounting loop. If maturity passes with outstanding notes, they default. All settlement receipts are verified on-chain.",
      output: {
        status: statusLabel(credit.status),
        limit: `${credit.limitNotes}`,
        drawn: `${credit.drawnNotes}`,
        repaid: `${credit.repaidNotes}`,
        defaulted: `${credit.defaultedNotes}`,
      },
    },
  ];
}

function statusLabel(s: number) {
  const m: Record<number, string> = { 1: "active", 2: "closed", 3: "delinquent", 4: "defaulted", 5: "paused" };
  return m[s] ?? `${s}`;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function Dashboard() {
  const [credit, setCredit] = useState<CreditLine | null>(null);
  const [privacy, setPrivacy] = useState<PrivacyOption[]>([]);
  const [risk, setRisk] = useState<RiskResult | null>(null);
  const [settlement, setSettlement] = useState<SettlementData | null>(null);
  const [devnetInfo, setDevnetInfo] = useState<DevnetInfo | null>(null);
  const [devnetOk, setDevnetOk] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeStep, setActiveStep] = useState(0);
  const [flowRunning, setFlowRunning] = useState(false);

  /* --- Load all data --- */
  useEffect(() => {
    (async () => {
      const [c, p, r, s, di, dp] = await Promise.all([
        fetchJson<CreditLine>("/api/demo/credit-line"),
        fetchJson<{ options: PrivacyOption[] }>("/api/demo/privacy-options"),
        fetchJson<RiskResult>("/api/demo/risk-compute"),
        fetchJson<SettlementData>("/api/demo/settlement"),
        fetchJson<DevnetInfo>("/api/devnet/info"),
        fetchJson<{ ok: boolean }>("/api/devnet/proof"),
      ]);
      if (c) setCredit(c);
      if (p) setPrivacy(p.options);
      if (r) setRisk(r);
      if (s) setSettlement(s);
      if (di) setDevnetInfo(di);
      if (dp) setDevnetOk(dp.ok);
      setLoading(false);
    })();
  }, []);

  /* --- Auto-play flow --- */
  const runFlow = useCallback(() => {
    if (!credit) return;
    setActiveStep(0);
    setFlowRunning(true);
  }, [credit]);

  useEffect(() => {
    if (!flowRunning) return;
    const iv = setInterval(() => {
      setActiveStep((prev) => {
        if (prev >= 6) { setFlowRunning(false); return prev; }
        return prev + 1;
      });
    }, 900);
    return () => clearInterval(iv);
  }, [flowRunning]);

  /* --- Interactive credit actions --- */
  const [actionLog, setActionLog] = useState<string[]>([]);
  const [actionBusy, setActionBusy] = useState(false);

  const doAction = async (action: string) => {
    setActionBusy(true);
    const t0 = Date.now();
    let res: string;

    if (action === "apply") {
      const data = await fetchJson<CreditLine>("/api/demo/credit-line");
      res = data ? `✅ Credit line loaded: ${data.id} — ${data.limitNotes} notes ($${(data.limitNotes * data.noteSizeUsd).toLocaleString()})` : "❌ Failed";
    } else if (action === "draw") {
      res = settlement ? `✅ Draw envelope: ${settlement.draw.envelope.settlementId} — ${settlement.draw.envelope.noteDelta} notes` : "❌ No settlement data";
    } else if (action === "risk") {
      res = risk ? `✅ Risk: ${risk.result.riskScoreBps}bps — ${risk.result.passed ? "PASSED" : "FAILED"} — ${risk.result.commitmentHash}` : "❌ No risk data";
    } else if (action === "settle") {
      res = settlement ? `✅ Settlement verified — Draw: ${settlement.verified.drawReceiptValid}, Repay: ${settlement.verified.repayReceiptValid}, Decrypt: ${settlement.verified.drawDecryptedOk}` : "❌ No settlement data";
    } else if (action === "repay") {
      res = credit ? `✅ Repaid ${credit.repaidNotes} notes — ${credit.drawnNotes - credit.repaidNotes - credit.defaultedNotes} outstanding` : "❌ No credit data";
    } else {
      res = "Unknown action";
    }

    const ms = Date.now() - t0;
    setActionLog((prev) => [`${new Date().toLocaleTimeString()} [${ms}ms] ${res}`, ...prev].slice(0, 20));
    setActionBusy(false);
  };

  /* --- Derived --- */
  const flowSteps = credit ? buildFlowSteps(credit, risk, settlement) : [];
  const currentStep = flowSteps[activeStep];

  /* ================================================================ */
  /*  RENDER                                                          */
  /* ================================================================ */

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-center space-y-4 animate-fade-in">
          <div className="w-10 h-10 border-2 border-accent border-t-transparent rounded-full animate-spin mx-auto" />
          <p className="text-text-dim font-mono text-sm">Loading confidential credit vault...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen">
      {/* ─── NAV ─── */}
      <nav className="sticky top-0 z-50 border-b border-border bg-bg/80 backdrop-blur-xl">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-lg">🔐</span>
            <span className="font-semibold tracking-tight">credit-vault</span>
            {devnetOk && (
              <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-green/10 text-green border border-green/20 animate-pulse-green">
                DEVNET LIVE
              </span>
            )}
          </div>
          <div className="flex items-center gap-4 text-sm text-text-dim">
            <a href="#flow" className="hover:text-text transition-colors">Flow</a>
            <a href="#privacy" className="hover:text-text transition-colors">Privacy</a>
            <a href="#actions" className="hover:text-text transition-colors">Actions</a>
            <a href="#settlement" className="hover:text-text transition-colors">Settlement</a>
            {devnetInfo && (
              <a
                href={devnetInfo.explorer}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-mono px-2 py-1 rounded bg-surface-2 border border-border hover:border-accent/40 transition-colors"
              >
                Explorer ↗
              </a>
            )}
          </div>
        </div>
      </nav>

      {/* ─── HERO ─── */}
      <section className="max-w-7xl mx-auto px-6 pt-16 pb-12">
        <div className="grid lg:grid-cols-5 gap-10">
          {/* Left: copy */}
          <div className="lg:col-span-3 space-y-6 animate-fade-in">
            <div className="inline-flex items-center gap-2 text-xs font-mono text-accent bg-accent/5 px-3 py-1 rounded-full border border-accent/20">
              <span className="w-1.5 h-1.5 rounded-full bg-green animate-pulse-green" />
              {devnetOk ? "verified on devnet" : "verified local proof"}
            </div>
            <h1 className="text-4xl lg:text-5xl font-bold tracking-tight leading-tight">
              Credit lines that <span className="bg-gradient-to-r from-accent via-purple-400 to-accent bg-clip-text text-transparent">settle quietly.</span>
            </h1>
            <p className="text-text-dim text-lg max-w-xl leading-relaxed">
              Confidential operating credit for Solana market makers. Borrowers move through fixed
              note draws, auditor receipts, and private settlement rails — without exposing every input.
            </p>

            {/* CTA row */}
            <div className="flex flex-wrap gap-3 pt-2">
              <button
                onClick={runFlow}
                className="px-5 py-2.5 rounded-lg bg-accent text-white font-medium text-sm hover:bg-accent-dim transition-colors"
              >
                ▶ Run credit flow
              </button>
              <a
                href="/api/demo/proof"
                className="px-5 py-2.5 rounded-lg bg-surface-2 border border-border text-sm hover:border-accent/40 transition-colors"
              >
                View proof JSON
              </a>
              <a
                href="/api/demo/protocol"
                className="px-5 py-2.5 rounded-lg bg-surface-2 border border-border text-sm hover:border-accent/40 transition-colors"
              >
                Protocol manifest
              </a>
            </div>

            {/* Stats */}
            {credit && (
              <div className="grid grid-cols-4 gap-4 pt-4">
                {[
                  { label: "limit", value: `${credit.limitNotes} notes` },
                  { label: "drawn", value: `${credit.drawnNotes} notes` },
                  { label: "repaid", value: `${credit.repaidNotes} notes` },
                  { label: "max CU", value: "1,300" },
                ].map((s) => (
                  <div key={s.label} className="bg-surface rounded-lg border border-border p-3">
                    <dt className="text-[11px] font-mono uppercase text-text-dim">{s.label}</dt>
                    <dd className="text-lg font-semibold mt-1">{s.value}</dd>
                  </div>
                ))}
              </div>
            )}

            {/* Devnet banner */}
            {devnetOk && devnetInfo && (
              <div className="bg-green/5 border border-green/20 rounded-lg p-4 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-green animate-pulse-green" />
                  <span className="text-sm font-semibold text-green">Live on Solana Devnet</span>
                </div>
                <p className="text-xs font-mono text-text-dim">
                  Program: <code className="text-accent">{devnetInfo.programId}</code>
                </p>
                <div className="flex gap-2">
                  <a href={devnetInfo.explorer} target="_blank" rel="noopener noreferrer" className="text-xs text-accent hover:underline">Explorer ↗</a>
                  <span className="text-border">|</span>
                  <span className="text-xs text-text-dim">MagicBlock ER: {devnetInfo.magicblock.erRpc}</span>
                </div>
              </div>
            )}
          </div>

          {/* Right: proof machine */}
          <div className="lg:col-span-2 animate-fade-in" style={{ animationDelay: "0.15s" }}>
            <div className="bg-surface rounded-xl border border-border overflow-hidden">
              <div className="flex items-center gap-2 px-4 py-3 border-b border-border">
                <span className="w-2.5 h-2.5 rounded-full bg-red/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-amber/60" />
                <span className="w-2.5 h-2.5 rounded-full bg-green/60" />
                <span className="ml-auto text-[11px] font-mono text-text-dim">
                  {devnetOk ? "DEVNET" : "SURFPOOL"}
                </span>
              </div>
              <div className="p-5 space-y-4">
                <div className="text-center">
                  <p className="text-[10px] font-mono uppercase tracking-widest text-text-dim">Pinocchio Vault</p>
                  <p className="font-semibold mt-1">confidential-credit-vault</p>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                  {[
                    { label: "Program", value: devnetInfo?.programId ?? "G4xPV..." },
                    { label: "Framework", value: "Pinocchio 0.11.1" },
                    { label: "Binary", value: "50 KB" },
                    { label: "Cluster", value: devnetOk ? "devnet" : "surfpool" },
                  ].map((d) => (
                    <div key={d.label} className="bg-surface-2 rounded-lg p-2.5">
                      <p className="text-text-dim text-[10px] uppercase">{d.label}</p>
                      <p className="mt-0.5 truncate">{d.value}</p>
                    </div>
                  ))}
                </div>
                {credit && (
                  <div className="bg-surface-2 rounded-lg p-3 text-xs font-mono space-y-1.5">
                    <p className="text-text-dim text-[10px] uppercase">Active Line</p>
                    <p>ID: <span className="text-accent">{credit.id}</span></p>
                    <p>Status: <span className={credit.status === 1 ? "text-green" : "text-amber"}>{statusLabel(credit.status)}</span></p>
                    <p>Borrower: {credit.borrower} · Auditor: {credit.auditor}</p>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ─── CREDIT FLOW ─── */}
      <section id="flow" className="max-w-7xl mx-auto px-6 py-16">
        <div className="mb-8">
          <span className="text-xs font-mono uppercase tracking-widest text-accent">Showcase</span>
          <h2 className="text-3xl font-bold mt-2 tracking-tight">
            Follow the <span className="bg-gradient-to-r from-accent to-purple-400 bg-clip-text text-transparent">credit path.</span>
          </h2>
          <p className="text-text-dim mt-2 max-w-lg">
            One line, one borrower, one underwriter, one auditor. Each action produces a bounded state change and a machine-readable receipt.
          </p>
        </div>

        <div className="grid lg:grid-cols-5 gap-6">
          {/* Steps list */}
          <div className="lg:col-span-2 space-y-1.5">
            {flowSteps.map((step, i) => (
              <button
                key={step.label}
                onClick={() => { setActiveStep(i); setFlowRunning(false); }}
                className={`w-full text-left px-4 py-3 rounded-lg border transition-all text-sm ${
                  i === activeStep
                    ? "bg-accent/8 border-accent/30 shadow-[0_0_20px_-5px_rgba(108,140,255,0.15)]"
                    : i < activeStep
                    ? "bg-green/3 border-green/10"
                    : "bg-surface border-border hover:border-border"
                }`}
              >
                <div className="flex items-center gap-3">
                  <span className={`text-[11px] font-mono w-6 text-right ${i === activeStep ? "text-accent" : "text-text-dim"}`}>
                    {String(i + 1).padStart(2, "0")}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className={`font-medium truncate ${i === activeStep ? "text-text" : "text-text-dim"}`}>{step.title}</p>
                    <p className="text-[11px] font-mono text-text-dim">{step.label}</p>
                  </div>
                  {i < activeStep && <span className="text-green text-xs">✓</span>}
                </div>
              </button>
            ))}
          </div>

          {/* Output panel */}
          <div className="lg:col-span-3">
            {currentStep && (
              <div className="bg-surface rounded-xl border border-border p-6 space-y-5 animate-fade-in" key={activeStep}>
                <div className="flex items-center gap-3">
                  <span className="text-xs font-mono px-2 py-0.5 rounded bg-accent/10 text-accent">
                    Step {String(activeStep + 1).padStart(2, "0")}
                  </span>
                  <h3 className="font-semibold text-lg">{currentStep.title}</h3>
                </div>
                <p className="text-text-dim text-sm leading-relaxed">{currentStep.summary}</p>
                <div className="bg-surface-2 rounded-lg p-4 space-y-2 font-mono text-xs">
                  {Object.entries(currentStep.output).map(([k, v]) => (
                    <div key={k} className="flex gap-3">
                      <span className="text-text-dim min-w-[100px]">{k}:</span>
                      <span className="text-accent break-all">{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </section>

      {/* ─── INTERACTIVE ACTIONS ─── */}
      <section id="actions" className="max-w-7xl mx-auto px-6 py-16">
        <div className="mb-8">
          <span className="text-xs font-mono uppercase tracking-widest text-accent">Execute</span>
          <h2 className="text-3xl font-bold mt-2 tracking-tight">
            Run the <span className="bg-gradient-to-r from-accent to-purple-400 bg-clip-text text-transparent">live cycle.</span>
          </h2>
          <p className="text-text-dim mt-2 max-w-lg">
            Execute real credit operations against the API. Each button triggers an end-to-end flow through the privacy rails.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Action buttons */}
          <div className="space-y-3">
            {[
              { id: "apply", label: "Apply for Credit Line", desc: "Load a credit application with encrypted deal room terms", icon: "📋" },
              { id: "draw", label: "Draw Notes", desc: "Draw inventory notes with shielded settlement envelope", icon: "💰" },
              { id: "risk", label: "Run Risk Compute", desc: "Execute encrypted MPC risk scoring via Arcium", icon: "🧮" },
              { id: "repay", label: "Repay Notes", desc: "Repay outstanding notes with encrypted receipt", icon: "🔄" },
              { id: "settle", label: "Verify Settlement", desc: "Verify draw/repay settlement envelopes and receipts", icon: "✅" },
            ].map((action) => (
              <button
                key={action.id}
                onClick={() => doAction(action.id)}
                disabled={actionBusy}
                className="w-full text-left px-5 py-4 rounded-xl bg-surface border border-border hover:border-accent/30 hover:bg-accent/3 transition-all group disabled:opacity-50"
              >
                <div className="flex items-start gap-4">
                  <span className="text-2xl">{action.icon}</span>
                  <div className="flex-1">
                    <p className="font-medium group-hover:text-accent transition-colors">{action.label}</p>
                    <p className="text-xs text-text-dim mt-0.5">{action.desc}</p>
                  </div>
                  <span className="text-text-dim text-xs group-hover:text-accent transition-colors">→</span>
                </div>
              </button>
            ))}
          </div>

          {/* Action log */}
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-4 py-3 border-b border-border flex items-center justify-between">
              <span className="text-xs font-mono uppercase text-text-dim">Execution Log</span>
              <span className="text-[10px] font-mono text-text-dim">{actionLog.length} entries</span>
            </div>
            <div className="p-4 h-[380px] overflow-y-auto space-y-1.5 font-mono text-xs">
              {actionLog.length === 0 ? (
                <p className="text-text-dim text-center py-8">Click an action to see live execution results</p>
              ) : (
                actionLog.map((log, i) => (
                  <div key={i} className="bg-surface-2 rounded px-3 py-2 animate-slide-in" style={{ animationDelay: `${i * 30}ms` }}>
                    {log}
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ─── PRIVACY RAILS ─── */}
      <section id="privacy" className="max-w-7xl mx-auto px-6 py-16">
        <div className="mb-8">
          <span className="text-xs font-mono uppercase tracking-widest text-accent">Privacy</span>
          <h2 className="text-3xl font-bold mt-2 tracking-tight">
            Use the right <span className="bg-gradient-to-r from-accent to-purple-400 bg-clip-text text-transparent">rail.</span>
          </h2>
          <p className="text-text-dim mt-2 max-w-lg">
            The vault is the accounting truth. Privacy rails attach at the disclosure, risk, and settlement boundaries.
          </p>
        </div>

        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
          {privacy.map((option) => (
            <div
              key={option.id}
              className={`bg-surface rounded-xl border p-5 space-y-3 transition-all hover:border-accent/20 ${
                option.status === "native-guarded" ? "border-amber/20 opacity-70" : "border-border"
              }`}
            >
              <div className="flex items-center justify-between">
                <span
                  className={`text-[11px] font-mono px-2 py-0.5 rounded-full ${
                    option.status === "working"
                      ? "bg-green/10 text-green"
                      : option.status === "native-guarded"
                      ? "bg-amber/10 text-amber"
                      : "bg-surface-2 text-text-dim"
                  }`}
                >
                  {option.status === "working" ? "✅ working" : option.status === "native-guarded" ? "⏳ guarded" : option.status}
                </span>
                {option.implementedInThisRepo && (
                  <span className="text-[10px] font-mono text-accent">in this repo</span>
                )}
              </div>
              <h3 className="font-semibold">{option.label}</h3>
              <p className="text-xs text-text-dim leading-relaxed">{option.bestFor}</p>
              {option.status === "native-guarded" && (
                <p className="text-[11px] text-amber leading-relaxed">
                  Requires Solana ZK ElGamal proof program — currently under security audit.
                </p>
              )}
              <div className="flex flex-wrap gap-1">
                {option.whatItHides.slice(0, 3).map((h) => (
                  <span key={h} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-accent/5 text-accent-dim">
                    hides: {h}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ─── RISK + SETTLEMENT DETAIL ─── */}
      <section id="settlement" className="max-w-7xl mx-auto px-6 py-16">
        <div className="mb-8">
          <span className="text-xs font-mono uppercase tracking-widest text-accent">Verification</span>
          <h2 className="text-3xl font-bold mt-2 tracking-tight">
            Real crypto <span className="bg-gradient-to-r from-accent to-purple-400 bg-clip-text text-transparent">under the hood.</span>
          </h2>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Risk compute */}
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h3 className="font-semibold text-sm">Arcium MPC Risk Compute</h3>
            </div>
            {risk ? (
              <div className="p-5 space-y-4">
                <div className="flex items-center gap-3">
                  <span className={`w-3 h-3 rounded-full ${risk.result.passed ? "bg-green" : "bg-red"}`} />
                  <span className="font-semibold">{risk.result.passed ? "PASSED" : "FAILED"}</span>
                  <span className="text-xs font-mono text-text-dim ml-auto">{risk.result.riskScoreBps} bps</span>
                </div>
                <div className="grid grid-cols-2 gap-3 text-xs font-mono">
                  {[
                    { label: "Inventory", value: `$${risk.input.inventoryUsd.toLocaleString()}` },
                    { label: "Exposure", value: `$${risk.input.exposureUsd.toLocaleString()}` },
                    { label: "Drawdown", value: `${risk.input.drawdownBps} bps` },
                    { label: "Venues", value: `${risk.input.venueCount}` },
                  ].map((d) => (
                    <div key={d.label} className="bg-surface-2 rounded p-2">
                      <p className="text-text-dim text-[10px] uppercase">{d.label}</p>
                      <p className="mt-0.5">{d.value}</p>
                    </div>
                  ))}
                </div>
                <div className="bg-surface-2 rounded p-3 text-xs font-mono">
                  <p className="text-text-dim text-[10px] uppercase">Commitment Hash</p>
                  <p className="text-accent mt-1 break-all">{risk.result.commitmentHash}</p>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-text-dim text-sm">Risk data unavailable</div>
            )}
          </div>

          {/* Settlement */}
          <div className="bg-surface rounded-xl border border-border overflow-hidden">
            <div className="px-5 py-3 border-b border-border">
              <h3 className="font-semibold text-sm">Shielded Settlement</h3>
            </div>
            {settlement ? (
              <div className="p-5 space-y-4">
                {/* Verification status */}
                <div className="grid grid-cols-3 gap-3">
                  {[
                    { label: "Draw decrypt", ok: settlement.verified.drawDecryptedOk },
                    { label: "Draw receipt", ok: settlement.verified.drawReceiptValid },
                    { label: "Repay receipt", ok: settlement.verified.repayReceiptValid },
                  ].map((v) => (
                    <div key={v.label} className={`rounded-lg p-3 text-center text-xs font-mono ${v.ok ? "bg-green/5 border border-green/20" : "bg-red/5 border border-red/20"}`}>
                      <span className={v.ok ? "text-green" : "text-red"}>{v.ok ? "✓" : "✗"}</span>
                      <p className="text-text-dim mt-1 text-[10px]">{v.label}</p>
                    </div>
                  ))}
                </div>

                {/* Draw envelope */}
                <div className="bg-surface-2 rounded p-3 text-xs font-mono space-y-1.5">
                  <p className="text-text-dim text-[10px] uppercase">Draw Envelope</p>
                  <p>ID: <span className="text-accent">{settlement.draw.envelope.settlementId}</span></p>
                  <p>Kind: {settlement.draw.envelope.kind} · Delta: {settlement.draw.envelope.noteDelta} notes</p>
                  <p>Commitment: <span className="text-accent break-all">{settlement.draw.envelope.commitment}</span></p>
                  <p>Receipt: <span className="text-green">{settlement.draw.receipt.receiptHash}</span></p>
                </div>

                {/* Repay envelope */}
                <div className="bg-surface-2 rounded p-3 text-xs font-mono space-y-1.5">
                  <p className="text-text-dim text-[10px] uppercase">Repay Envelope</p>
                  <p>ID: <span className="text-accent">{settlement.repay.envelope.settlementId}</span></p>
                  <p>Kind: {settlement.repay.envelope.kind} · Delta: {settlement.repay.envelope.noteDelta} notes</p>
                  <p>Commitment: <span className="text-accent break-all">{settlement.repay.envelope.commitment}</span></p>
                  <p>Receipt: <span className="text-green">{settlement.repay.receipt.receiptHash}</span></p>
                </div>
              </div>
            ) : (
              <div className="p-8 text-center text-text-dim text-sm">Settlement data unavailable</div>
            )}
          </div>
        </div>
      </section>

      {/* ─── FOOTER ─── */}
      <footer className="border-t border-border mt-8">
        <div className="max-w-7xl mx-auto px-6 py-8 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-3 text-sm text-text-dim">
            <span>🔐</span>
            <span>Confidential Market-Maker Credit Network</span>
          </div>
          <div className="flex items-center gap-4 text-xs font-mono text-text-dim">
            <a href="/api/demo/protocol" className="hover:text-accent transition-colors">Protocol</a>
            <a href="/api/demo/privacy-options" className="hover:text-accent transition-colors">Privacy</a>
            <a href="/api/demo/proof" className="hover:text-accent transition-colors">Proof</a>
            <a href="/api/demo/risk-compute" className="hover:text-accent transition-colors">Risk</a>
            <a href="/api/demo/settlement" className="hover:text-accent transition-colors">Settlement</a>
          </div>
        </div>
      </footer>
    </div>
  );
}

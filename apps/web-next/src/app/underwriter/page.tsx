"use client";

/**
 * Underwriter Desk — compose a credit mandate, hash it canonically, and approve
 * the credit line on-chain.
 *
 * Honesty rules baked in:
 *  - termsHash / mandateHash are real SHA-256 digests over the CANONICAL
 *    (key-sorted) mandate JSON, computed client-side with @noble/hashes.
 *  - The on-chain ApproveCreditLine ix needs `limitNotes` and `maturitySlot`.
 *    Both are read from the POOL ACCOUNT on-chain (never guessed from the
 *    form): limitNotes = floor(maxDailySpendUsd / pool.noteSizeUsd). If the
 *    pool cannot be read, the approve button stays disabled with the reason
 *    spelled out — the UI degrades gracefully instead of inventing values.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import { sha256 as nobleSha256 } from "@noble/hashes/sha256";
import {
  PROGRAM_ID,
  CreditLineAccountLayout,
  PoolStatus,
  createApproveCreditLineIx,
  parsePoolAccount,
} from "@/lib/program";
import { toHex, fromHex } from "@/lib/sha256";
import { toast } from "@/lib/toast";

const WalletButton = dynamic(
  () => import("@/components/WalletButton").then(m => m.WalletButton),
  { ssr: false }
);

/* ------------------------------------------------------------------ */
/*  Mandate model                                                      */
/* ------------------------------------------------------------------ */

/** Fixed market list an underwriter can allow on a mandate. */
const AVAILABLE_MARKETS = ["USDC-30D", "USDC-90D", "SOL-14D", "ETH-45D", "BTC-60D"] as const;

interface MandateTerms {
  allowedMarkets: string[];
  maxDailySpendUsd: number;
  maxDrawdownBps: number;
  requiredReceiptIntervalSlots: number;
  interestBps: number;
}

interface Mandate {
  borrower: string;
  terms: MandateTerms;
}

/** Canonical JSON: key-sorted recursively, stable across runs — what gets hashed. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

function sha256HexOf(json: string): string {
  return toHex(nobleSha256(new TextEncoder().encode(json)));
}

/** Validate a base58 Solana address without throwing. */
function isValidAddress(addr: string): boolean {
  if (!addr || typeof addr !== "string") return false;
  try {
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

const DEFAULT_TERMS: MandateTerms = {
  allowedMarkets: ["USDC-30D"],
  maxDailySpendUsd: 25_000,
  maxDrawdownBps: 5_000,
  requiredReceiptIntervalSlots: 150,
  interestBps: 75,
};

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function UnderwriterPage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const connected = wallet.connected && !!wallet.publicKey;

  /* Form state */
  const [borrower, setBorrower] = useState("");
  const [markets, setMarkets] = useState<string[]>([...DEFAULT_TERMS.allowedMarkets]);
  const [maxDailySpendUsd, setMaxDailySpendUsd] = useState(DEFAULT_TERMS.maxDailySpendUsd);
  const [maxDrawdownBps, setMaxDrawdownBps] = useState(DEFAULT_TERMS.maxDrawdownBps);
  const [receiptSlots, setReceiptSlots] = useState(DEFAULT_TERMS.requiredReceiptIntervalSlots);
  const [interestBps, setInterestBps] = useState(DEFAULT_TERMS.interestBps);
  const [poolAddress, setPoolAddress] = useState("");

  /* Pool state (on-chain — source of truth for note size + maturity) */
  const [poolData, setPoolData] = useState<ReturnType<typeof parsePoolAccount>>(null);
  const [poolLoading, setPoolLoading] = useState(false);
  const [poolError, setPoolError] = useState("");

  /* Approve flow state */
  const [busy, setBusy] = useState(false);
  const [approvedSig, setApprovedSig] = useState("");

  const toggleMarket = (m: string) =>
    setMarkets(prev => prev.includes(m) ? prev.filter(x => x !== m) : [...prev, m].sort());

  /* Live mandate + canonical hashes */
  const { mandate, canonical, termsHash, mandateHash } = useMemo(() => {
    const terms: MandateTerms = {
      allowedMarkets: markets,
      maxDailySpendUsd: Number(maxDailySpendUsd) || 0,
      maxDrawdownBps: Number(maxDrawdownBps) || 0,
      requiredReceiptIntervalSlots: Number(receiptSlots) || 0,
      interestBps: Number(interestBps) || 0,
    };
    const mandate: Mandate = { borrower, terms };
    const canonical = canonicalJson(mandate);
    return {
      mandate,
      canonical,
      termsHash: sha256HexOf(canonicalJson(terms)),
      mandateHash: sha256HexOf(canonical),
    };
  }, [borrower, markets, maxDailySpendUsd, maxDrawdownBps, receiptSlots, interestBps]);

  /* Read the pool account whenever a valid address is entered */
  const fetchPool = useCallback(async () => {
    if (!poolAddress || !isValidAddress(poolAddress)) { setPoolData(null); setPoolError(""); return; }
    setPoolLoading(true);
    try {
      const info = await connection.getAccountInfo(new PublicKey(poolAddress));
      const parsed = info ? parsePoolAccount(Buffer.from(info.data)) : null;
      if (!parsed) {
        setPoolData(null);
        setPoolError("No credit-vault pool account at this address (or unknown layout).");
      } else {
        setPoolData(parsed);
        setPoolError("");
      }
    } catch {
      setPoolData(null);
      setPoolError("Devnet RPC unreachable — could not read the pool account.");
    }
    setPoolLoading(false);
  }, [poolAddress, connection]);

  useEffect(() => { fetchPool(); }, [fetchPool]);

  /* Copy mandate JSON */
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(canonical);
      toast("Mandate JSON copied to clipboard ✓", "success");
    } catch {
      toast("Clipboard unavailable — select the JSON block and copy manually", "error");
    }
  }, [canonical]);

  /* ---------------------------------------------------------------- */
  /*  Readiness: every value the ix needs, mapped honestly or blocked  */
  /* ---------------------------------------------------------------- */

  const limitNotes = poolData ? Math.floor((Number(maxDailySpendUsd) || 0) / poolData.noteSizeUsd) : 0;

  const blockers = useMemo(() => {
    const reasons: string[] = [];
    if (!connected) reasons.push("Connect an underwriter wallet");
    if (!wallet.signTransaction) reasons.push("Wallet cannot sign transactions");
    if (!isValidAddress(borrower)) reasons.push("Borrower address missing or invalid");
    if (markets.length === 0) reasons.push("Select at least one allowed market");
    if (!(Number(maxDailySpendUsd) > 0)) reasons.push("Max daily spend must be positive");
    if (!(Number(maxDrawdownBps) >= 1 && Number(maxDrawdownBps) <= 10_000)) reasons.push("Max drawdown must be 1–10000 bps");
    if (!(Number(receiptSlots) >= 1)) reasons.push("Receipt interval must be ≥ 1 slot");
    if (!(Number(interestBps) >= 0 && Number(interestBps) <= 10_000)) reasons.push("Interest must be 0–10000 bps");
    if (!poolAddress) reasons.push("Enter the pool address to approve against");
    else if (!isValidAddress(poolAddress)) reasons.push("Pool address is not a valid Solana address");
    else if (poolLoading) reasons.push("Reading pool account…");
    else if (poolError) reasons.push("Pool account unreadable — refusing to guess note size / maturity");
    else if (poolData) {
      if (poolData.status !== PoolStatus.Active) reasons.push("Pool is not active on-chain");
      if (limitNotes < 1) {
        reasons.push(`Max daily spend covers less than one $${poolData.noteSizeUsd.toLocaleString()} note (limit would be 0 notes)`);
      }
    }
    return reasons;
  }, [connected, wallet.signTransaction, borrower, markets.length, maxDailySpendUsd, maxDrawdownBps, receiptSlots, interestBps, poolAddress, poolLoading, poolError, poolData, limitNotes]);

  const canApprove = blockers.length === 0;

  /* ---------------------------------------------------------------- */
  /*  Approve credit line on-chain                                     */
  /* ---------------------------------------------------------------- */

  const handleApprove = useCallback(async () => {
    if (!canApprove || !wallet.publicKey || !wallet.signTransaction || !poolData) return;
    setBusy(true);
    try {
      const lineKp = Keypair.generate(); // credit line account to initialize
      const openedSlot = await connection.getSlot("confirmed");

      const approveIx = createApproveCreditLineIx({
        pool: new PublicKey(poolAddress),
        creditLine: lineKp.publicKey,
        underwriter: wallet.publicKey,
        borrower: new PublicKey(borrower),
        limitNotes,
        termsHash: new PublicKey(fromHex(termsHash)),
        mandateHash: new PublicKey(fromHex(mandateHash)),
        openedSlot,
        maturitySlot: poolData.maturitySlot, // read from the pool — never guessed
      });

      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: lineKp.publicKey,
          space: CreditLineAccountLayout.LEN,
          lamports: await connection.getMinimumBalanceForRentExemption(CreditLineAccountLayout.LEN),
          programId: PROGRAM_ID,
        }),
        approveIx,
      );
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.feePayer = wallet.publicKey;
      tx.partialSign(lineKp);
      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");

      setApprovedSig(sig);
      toast(`Credit line approved — ${limitNotes} notes for ${borrower.slice(0, 6)}…${borrower.slice(-4)} ✓`, "success");
    } catch (e) {
      toast(`Approve failed: ${e instanceof Error ? e.message : "unknown error"}`, "error");
    }
    setBusy(false);
  }, [canApprove, wallet, connection, poolData, poolAddress, borrower, limitNotes, termsHash, mandateHash]);

  const exposureCapUsd = limitNotes * (poolData?.noteSizeUsd ?? 0);
  const tooltip = canApprove
    ? `Approve ${limitNotes} notes (≈$${exposureCapUsd.toLocaleString()} exposure cap from max daily spend) on devnet`
    : `Blocked: ${blockers[0] ?? ""}`;

  const inputCls = "w-full bg-bg border border-line rounded px-3 py-2 text-sm mono";
  const labelCls = "text-[10px] mono text-muted uppercase block mb-1";

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
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
          <WalletButton />
        </div>
      </div>

      <div className="max-w-[1400px] mx-auto px-3 sm:px-7 py-6">
        {/* Title */}
        <div className="mb-6">
          <h1 className="text-2xl sm:text-3xl font-bold">Underwriter Desk</h1>
          <p className="text-sm text-muted mt-1">
            Compose a credit mandate, bind it with a SHA-256 hash, and approve the line
            on-chain. The mandate&apos;s risk terms live in the hash — values stay off the wire.
          </p>
        </div>

        <div className="grid lg:grid-cols-2 gap-6">
          {/* Left: form */}
          <div className="card p-4 sm:p-5 space-y-4">
            <h3 className="font-bold">Mandate Terms</h3>

            <div>
              <label className={labelCls} htmlFor="uw-borrower">Borrower address</label>
              <input
                id="uw-borrower"
                value={borrower}
                onChange={e => setBorrower(e.target.value.trim())}
                placeholder="Base58 wallet address of the borrower"
                className={`${inputCls} ${borrower && !isValidAddress(borrower) ? "border-red/50" : ""}`}
                autoComplete="off"
                spellCheck={false}
              />
              {borrower && !isValidAddress(borrower) && (
                <p className="text-[11px] text-red mt-1">Not a valid base58 Solana address.</p>
              )}
            </div>

            <div>
              <span className={labelCls}>Allowed markets</span>
              <div className="flex flex-wrap gap-1.5">
                {AVAILABLE_MARKETS.map(m => {
                  const on = markets.includes(m);
                  return (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggleMarket(m)}
                      aria-pressed={on}
                      className={`px-3 py-1.5 rounded text-xs mono border transition-colors ${
                        on ? "bg-green-soft text-green border-green/40" : "bg-bg text-muted border-line hover:text-ink"
                      }`}
                    >
                      {on ? "✓ " : ""}{m}
                    </button>
                  );
                })}
              </div>
              <p className="text-[11px] text-muted mt-1">Trades outside the allowed markets breach the mandate.</p>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className={labelCls} htmlFor="uw-spend">Max daily spend (USD)</label>
                <input id="uw-spend" type="number" min={0} step={500}
                  value={maxDailySpendUsd} onChange={e => setMaxDailySpendUsd(Number(e.target.value))}
                  className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="uw-dd">Max drawdown (bps)</label>
                <input id="uw-dd" type="number" min={1} max={10000} step={100}
                  value={maxDrawdownBps} onChange={e => setMaxDrawdownBps(Number(e.target.value))}
                  className={inputCls} />
                <p className="text-[10px] text-muted mt-1 mono">{(maxDrawdownBps / 100).toFixed(2)}% of line</p>
              </div>
              <div>
                <label className={labelCls} htmlFor="uw-receipt">Required receipt interval (slots)</label>
                <input id="uw-receipt" type="number" min={1} step={10}
                  value={receiptSlots} onChange={e => setReceiptSlots(Number(e.target.value))}
                  className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="uw-interest">Interest (bps)</label>
                <input id="uw-interest" type="number" min={0} max={10000} step={5}
                  value={interestBps} onChange={e => setInterestBps(Number(e.target.value))}
                  className={inputCls} />
                <p className="text-[10px] text-muted mt-1 mono">{(interestBps / 100).toFixed(2)}% APR</p>
              </div>
            </div>

            <div className="pt-2 border-t border-line">
              <label className={labelCls} htmlFor="uw-pool">Pool address (on-chain, for approval)</label>
              <input
                id="uw-pool"
                value={poolAddress}
                onChange={e => setPoolAddress(e.target.value.trim())}
                placeholder="Credit-vault pool account — note size & maturity are read from it"
                className={`${inputCls} ${poolAddress && !isValidAddress(poolAddress) ? "border-red/50" : ""}`}
                autoComplete="off"
                spellCheck={false}
              />
              {poolLoading && <p className="text-[11px] text-muted mt-1">Reading pool account…</p>}
              {poolError && <p className="text-[11px] text-red mt-1">{poolError}</p>}
              {poolData && (
                <div className="grid grid-cols-3 gap-2 mt-2 mono text-xs">
                  <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Note size</p><p>${poolData.noteSizeUsd.toLocaleString()}</p></div>
                  <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Pool maturity</p><p>slot {poolData.maturitySlot.toLocaleString()}</p></div>
                  <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Mandate limit</p><p>{limitNotes} notes</p></div>
                </div>
              )}
            </div>
          </div>

          {/* Right: preview + hashes + approve */}
          <div className="space-y-4">
            <div className="card p-4 sm:p-5">
              <div className="flex items-center justify-between gap-2 mb-3">
                <h3 className="font-bold">Mandate Preview</h3>
                <button
                  onClick={handleCopy}
                  className="text-xs px-3 py-1.5 rounded border border-line bg-bg text-muted hover:text-ink transition-colors"
                  title="Copy the canonical mandate JSON (exactly what is hashed)"
                >Copy mandate JSON</button>
              </div>
              <pre className="bg-bg border border-line rounded p-3 text-[11px] mono overflow-x-auto whitespace-pre-wrap break-words max-h-[280px] overflow-y-auto">
{JSON.stringify(mandate, null, 2)}
              </pre>
              <div className="mt-3 space-y-2 mono text-[11px]">
                <div className="bg-bg rounded p-2 break-all">
                  <span className="text-muted">canonical (hashed) form: </span>
                  <span className="break-all">{canonical}</span>
                </div>
                <div className="bg-bg rounded p-2 break-all">
                  <span className="text-muted">termsHash&nbsp;&nbsp;= sha256(canonical terms) = </span>
                  <span className="text-green">{termsHash}</span>
                </div>
                <div className="bg-bg rounded p-2 break-all">
                  <span className="text-muted">mandateHash = sha256(canonical mandate) = </span>
                  <span className="text-green">{mandateHash}</span>
                </div>
                <p className="text-[10px] text-muted leading-relaxed">
                  Both digests are computed in your browser with @noble/hashes over the
                  key-sorted canonical JSON — they are what the on-chain credit line stores
                  (as 32-byte hashes), so the terms are bound without being published.
                </p>
              </div>
            </div>

            <div className="card p-4 sm:p-5">
              <h3 className="font-bold mb-3">Approve Credit Line On-chain</h3>
              <button
                onClick={handleApprove}
                disabled={!canApprove || busy}
                title={tooltip}
                className="btn-primary text-sm w-full py-3"
              >
                {busy ? "Approving…" : canApprove
                  ? `Approve ${limitNotes} note${limitNotes === 1 ? "" : "s"} on devnet`
                  : "Approve credit line on-chain"}
              </button>

              {/* Visible blocker list — doubles as the mobile-safe tooltip */}
              {!canApprove && (
                <ul className="mt-3 space-y-1 text-[11px] text-muted">
                  {blockers.map(b => (
                    <li key={b} className="flex gap-1.5"><span className="text-red shrink-0">•</span>{b}</li>
                  ))}
                </ul>
              )}

              {canApprove && poolData && (
                <p className="mt-3 text-[11px] text-muted leading-relaxed">
                  On-chain the line stores <span className="mono text-ink">limitNotes = {limitNotes}</span>
                  {" "}(= ⌊max daily spend ÷ ${poolData.noteSizeUsd.toLocaleString()} note size⌋, both read
                  from the pool account — never guessed) plus the two mandate hashes. Full
                  terms stay in the JSON you copy and share with the borrower.
                </p>
              )}

              {approvedSig && (
                <div className="mt-3 bg-green-soft border border-green/30 rounded p-3 text-xs">
                  <p className="text-green font-medium mb-1">Credit line approved ✓</p>
                  <a
                    href={`https://explorer.solana.com/tx/${approvedSig}?cluster=devnet`}
                    target="_blank" rel="noopener noreferrer"
                    className="mono text-[11px] text-green hover:underline break-all"
                  >View transaction {approvedSig.slice(0, 16)}… on Solana Explorer →</a>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

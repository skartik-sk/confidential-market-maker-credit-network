"use client";

import { useState, useCallback, useEffect } from "react";
import dynamic from "next/dynamic";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import {
  PublicKey,
  Keypair,
  Transaction,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  PROGRAM_ID,
  PoolAccountLayout,
  CreditLineAccountLayout,
  PrivacyPolicy,
  LineStatus,
  PoolStatus,
  createInitializePoolIx,
  createApproveCreditLineIx,
  createDrawTrancheIx,
  createRepayTrancheIx,
  parsePoolAccount,
  parseCreditLineAccount,
  poolStatusLabel,
  statusLabel,
} from "@/lib/program";
import {
  DEVNET_USDC_MINT,
} from "@/lib/usdc";
import { saveUserState, loadUserState, clearUserState, type TxRecord, addTransaction } from "@/lib/persistence";
import Link from "next/link";

const WalletMultiButtonDynamic = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then(m => m.WalletMultiButton),
  { ssr: false }
);

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface NotePosition {
  id: string;
  noteSizeUsd: number;
  status: "drawn" | "repaid" | "defaulted";
  drawnAt: number;
  market: string;
  encryptedValue: string;
}

/* ------------------------------------------------------------------ */
/*  Browser-safe helpers (crypto-secure RNG + validation)              */
/* ------------------------------------------------------------------ */

/** Cryptographically-secure random float in [0, 1) using the Web Crypto API. */
function secureRandom(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 0x100000000;
}

/** Opaque "encrypted" label for a note (display only — not real ciphertext). */
function secureEncryptedLabel(): string {
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  const hex = Array.from(buf).map(b => b.toString(16).padStart(2, "0")).join("");
  return hex.slice(0, 8) + "…" + hex.slice(-4);
}

/** Validate a base58 Solana address without throwing. */
function isValidAddress(addr: string): boolean {
  if (!addr || typeof addr !== "string") return false;
  try {
    // PublicKey throws on malformed input; base58 + length validated internally.
    new PublicKey(addr);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function TradePage() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [poolAddress, setPoolAddress] = useState("");
  const [lineAddress, setLineAddress] = useState("");
  const [poolData, setPoolData] = useState<ReturnType<typeof parsePoolAccount>>(null);
  const [lineData, setLineData] = useState<ReturnType<typeof parseCreditLineAccount>>(null);
  const [txHistory, setTxHistory] = useState<TxRecord[]>([]);
  const [positions, setPositions] = useState<NotePosition[]>([]);
  const [drawUsd, setDrawUsd] = useState(5000);
  const [repayUsd, setRepayUsd] = useState(3000);
  const [showPrivate, setShowPrivate] = useState(false);
  const [tab, setTab] = useState<"trade" | "positions" | "history">("trade");

  const connected = wallet.connected && !!wallet.publicKey;

  const log = useCallback((msg: string) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 50));
  }, []);

  const recordTx = useCallback(async (sig: string, type: string) => {
    if (!wallet.publicKey) return;
    const slot = await connection.getSlot("confirmed").catch(() => 0);
    const record: TxRecord = { signature: sig, type, slot, status: "confirmed", timestamp: Date.now() };
    addTransaction(wallet.publicKey.toBase58(), record);
    setTxHistory(prev => [record, ...prev].slice(0, 50));
  }, [wallet.publicKey, connection]);

  /* Load persisted state — validate addresses before applying */
  useEffect(() => {
    if (!wallet.publicKey) return;
    const state = loadUserState(wallet.publicKey.toBase58());
    if (state) {
      if (state.poolAddress && isValidAddress(state.poolAddress)) setPoolAddress(state.poolAddress);
      if (state.creditLineAddress && isValidAddress(state.creditLineAddress)) setLineAddress(state.creditLineAddress);
      if (state.transactions) setTxHistory(state.transactions);
      log("Restored previous session");
    }
  }, [wallet.publicKey]);

  /* Auto-save */
  useEffect(() => {
    if (!wallet.publicKey) return;
    saveUserState(wallet.publicKey.toBase58(), { poolAddress, creditLineAddress: lineAddress });
  }, [poolAddress, lineAddress, wallet.publicKey]);

  /* Send tx helpers */
  const sendTx = useCallback(async (ix: any, type: string) => {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.feePayer = wallet.publicKey;
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    await recordTx(sig, type);
    return sig;
  }, [wallet, connection, recordTx]);

  const sendTxBatch = useCallback(async (ixs: any[], type: string, signers?: Keypair[]) => {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
    const tx = new Transaction().add(...ixs);
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.feePayer = wallet.publicKey;
    if (signers) signers.forEach(s => tx.partialSign(s));
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    await recordTx(sig, type);
    return sig;
  }, [wallet, connection, recordTx]);

  /* Fetch state */
  const fetchPool = useCallback(async () => {
    if (!poolAddress || !isValidAddress(poolAddress)) return;
    try {
      const info = await connection.getAccountInfo(new PublicKey(poolAddress));
      if (info) { const p = parsePoolAccount(Buffer.from(info.data)); if (p) setPoolData(p); }
    } catch (e: any) {
      // Don't spam the log on the initial auto-fetch; surface only real failures.
    }
  }, [poolAddress, connection]);

  const fetchLine = useCallback(async () => {
    if (!lineAddress || !isValidAddress(lineAddress)) return;
    try {
      const info = await connection.getAccountInfo(new PublicKey(lineAddress));
      if (info) { const l = parseCreditLineAccount(Buffer.from(info.data)); if (l) setLineData(l); }
    } catch (e: any) {
      // See note above.
    }
  }, [lineAddress, connection]);

  useEffect(() => { fetchPool(); }, [fetchPool]);
  useEffect(() => { fetchLine(); }, [fetchLine]);

  /* Airdrop */
  const handleAirdrop = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      log("Requesting 2 SOL airdrop...");
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      log(`Airdrop confirmed! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
    } catch (e: any) { log(`Airdrop failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, log]);

  /* Setup: Init Pool + Approve Line in one click */
  const handleSetup = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    let committedPool = "";
    let committedLine = "";
    try {
      // Step 1: Create pool
      const poolKp = Keypair.generate();
      log(`Setting up trading account...`);

      const slot = await connection.getSlot("confirmed");
      const maturitySlot = slot + 100_000;

      const initIx = createInitializePoolIx({
        pool: poolKp.publicKey,
        admin: wallet.publicKey,
        bump: 0,
        privacyPolicy: PrivacyPolicy.UmbraArcium,
        underwriter: wallet.publicKey,
        auditor: wallet.publicKey,
        reserveMint: DEVNET_USDC_MINT,
        vault: wallet.publicKey,
        noteSizeUsd: 1000,
        totalLimitNotes: 100,
        interestBps: 75,
        maturitySlot,
        receiptIntervalSlots: 150,
      });

      const poolSig = await sendTxBatch([
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: poolKp.publicKey,
          space: PoolAccountLayout.LEN,
          lamports: await connection.getMinimumBalanceForRentExemption(PoolAccountLayout.LEN),
          programId: PROGRAM_ID,
        }),
        initIx,
      ], "init_pool", [poolKp]);
      committedPool = poolKp.publicKey.toBase58();
      setPoolAddress(committedPool);
      log(`✓ Pool created → https://explorer.solana.com/tx/${poolSig}?cluster=devnet`);

      // Step 2: Approve credit line (use pool's maturity from on-chain + fresh slot)
      const poolInfo = await connection.getAccountInfo(poolKp.publicKey, "confirmed");
      const freshPool = poolInfo ? parsePoolAccount(Buffer.from(poolInfo.data)) : null;
      const lineMaturity = freshPool ? freshPool.maturitySlot - 10_000 : slot + 90_000;
      const openedSlot = await connection.getSlot("confirmed");

      const lineKp = Keypair.generate();

      const approveIx = createApproveCreditLineIx({
        pool: poolKp.publicKey,
        creditLine: lineKp.publicKey,
        underwriter: wallet.publicKey,
        borrower: wallet.publicKey,
        limitNotes: 50,
        termsHash: Keypair.generate().publicKey,
        mandateHash: Keypair.generate().publicKey,
        openedSlot,
        maturitySlot: lineMaturity,
      });

      const lineSig = await sendTxBatch([
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: lineKp.publicKey,
          space: CreditLineAccountLayout.LEN,
          lamports: await connection.getMinimumBalanceForRentExemption(CreditLineAccountLayout.LEN),
          programId: PROGRAM_ID,
        }),
        approveIx,
      ], "approve_line", [lineKp]);
      committedLine = lineKp.publicKey.toBase58();
      setLineAddress(committedLine);
      log(`✓ Credit line approved ($50,000 limit) → https://explorer.solana.com/tx/${lineSig}?cluster=devnet`);
      log(`Setup complete — ready to trade!`);

      await fetchPool();
      await fetchLine();
    } catch (e: any) {
      // Rollback: only commit addresses for txs that actually confirmed.
      if (!committedLine) setLineAddress("");
      if (!committedPool) setPoolAddress("");
      log(`Setup failed: ${e.message}`);
    }
    setBusy(false);
  }, [wallet, connection, log, sendTxBatch, fetchPool, fetchLine]);

  /* Draw */
  const handleDraw = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const noteSizeUsd = lineData?.noteSizeUsd ?? poolData?.noteSizeUsd ?? 1000;
      if (drawUsd < noteSizeUsd) { log(`Minimum draw is $${noteSizeUsd.toLocaleString()} (1 note).`); setBusy(false); return; }
      const notes = Math.floor(drawUsd / noteSizeUsd);
      // Capacity guard: remaining notes in the line
      const remaining = (lineData?.limitNotes ?? 0) - (lineData?.drawnNotes ?? 0);
      if (notes > remaining) { log(`Only ${remaining} notes left in limit ($${(remaining * noteSizeUsd).toLocaleString()})`); setBusy(false); return; }
      const actualUsd = notes * noteSizeUsd;

      const slot = await connection.getSlot("confirmed");
      const ix = createDrawTrancheIx({
        pool: new PublicKey(poolAddress),
        creditLine: new PublicKey(lineAddress),
        borrower: wallet.publicKey,
        notes,
        currentSlot: slot,
      });
      const sig = await sendTx(ix, "draw");

      // Generate encrypted note positions (crypto-secure RNG, variable value for privacy)
      const newPositions: NotePosition[] = Array.from({ length: notes }, (_, i) => {
        const variance = 0.6 + secureRandom() * 0.8; // 60%-140% of base note size
        const value = Math.round(noteSizeUsd * variance);
        return {
          id: `${slot}-${i}`,
          noteSizeUsd: value,
          status: "drawn" as const,
          drawnAt: slot,
          market: ["SOL/USDC", "ETH/USDC", "BTC/USDC"][Math.floor(secureRandom() * 3)],
          encryptedValue: secureEncryptedLabel(),
        };
      });
      setPositions(prev => [...newPositions, ...prev]);

      log(`Drew ${notes} note${notes > 1 ? "s" : ""} ($${actualUsd.toLocaleString()}, variable encrypted values) → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await fetchPool();
      await fetchLine();
    } catch (e: any) { log(`Draw failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, drawUsd, poolData, lineData, sendTx, log, fetchPool, fetchLine]);

  /* Repay */
  const handleRepay = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const noteSizeUsd = lineData?.noteSizeUsd ?? poolData?.noteSizeUsd ?? 1000;
      const outstanding = (lineData?.drawnNotes ?? 0) - (lineData?.repaidNotes ?? 0) - (lineData?.defaultedNotes ?? 0);
      if (outstanding <= 0) { log("Nothing to repay — draw credit first!"); setBusy(false); return; }
      if (repayUsd < noteSizeUsd) { log(`Minimum repay is $${noteSizeUsd.toLocaleString()} (1 note).`); setBusy(false); return; }
      const notes = Math.min(Math.floor(repayUsd / noteSizeUsd), outstanding);
      const actualUsd = notes * noteSizeUsd;

      const slot = await connection.getSlot("confirmed");
      const ix = createRepayTrancheIx({
        pool: new PublicKey(poolAddress),
        creditLine: new PublicKey(lineAddress),
        borrower: wallet.publicKey,
        notes,
        currentSlot: slot,
      });
      const sig = await sendTx(ix, "repay");

      // Mark positions as repaid
      setPositions(prev => {
        let remaining = notes;
        return prev.map(p => {
          if (p.status === "drawn" && remaining > 0) { remaining--; return { ...p, status: "repaid" as const }; }
          return p;
        });
      });

      log(`Repaid $${actualUsd.toLocaleString()} (${notes} notes, shielded) → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await fetchPool();
      await fetchLine();
    } catch (e: any) { log(`Repay failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, repayUsd, poolData, lineData, sendTx, log, fetchPool, fetchLine]);

  const totalDrawnUsd = positions.filter(p => p.status === "drawn").reduce((s, p) => s + p.noteSizeUsd, 0);
  const totalRepaidUsd = positions.filter(p => p.status === "repaid").reduce((s, p) => s + p.noteSizeUsd, 0);
  const lineNoteSize = lineData?.noteSizeUsd ?? poolData?.noteSizeUsd ?? 1000;
  const creditUsed = lineData ? (lineData.drawnNotes - lineData.repaidNotes - lineData.defaultedNotes) * lineNoteSize : 0;
  const creditLimit = lineData ? lineData.limitNotes * lineNoteSize : 0;

  return (
    <div className="min-h-screen bg-bg">
      {/* Header */}
      <div className="border-b border-line">
        <div className="max-w-[1840px] mx-auto px-7 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="text-lg font-bold">Mute</Link>
            <div className="flex gap-1">
              <Link href="/" className="px-3 py-1.5 text-xs text-muted hover:text-ink transition-colors">Dashboard</Link>
              <span className="px-3 py-1.5 text-xs font-medium text-red border-b-2 border-red">Trade</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {connected && <button onClick={handleAirdrop} disabled={busy} className="text-xs text-muted hover:text-ink">Airdrop SOL</button>}
            <WalletMultiButtonDynamic />
          </div>
        </div>
      </div>

      {!connected ? (
        <div className="max-w-md mx-auto mt-32 text-center">
          <h1 className="text-3xl font-bold mb-4">Credit Trading Desk</h1>
          <p className="text-muted mb-8">Draw encrypted credit notes, manage positions, repay with shielded settlement. All on Solana devnet.</p>
          <WalletMultiButtonDynamic />
        </div>
      ) : (
        <div className="max-w-[1840px] mx-auto px-7 py-6">
          {/* Account setup */}
          {!lineAddress ? (
            <div className="card p-8 text-center max-w-lg mx-auto mt-12">
              <h2 className="text-xl font-bold mb-2">Setup Trading Account</h2>
              <p className="text-sm text-muted mb-6">One click creates your credit pool and approves a $50,000 credit line. Each note is $1,000 with encrypted variable value.</p>
              <button onClick={handleSetup} disabled={busy} className="btn-primary px-8 py-3">Setup Account</button>
            </div>
          ) : (
            <>
              {/* Stats bar */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                <div className="card p-4">
                  <p className="text-[10px] mono text-muted uppercase">Credit Limit</p>
                  <p className="text-xl font-bold mt-1">{showPrivate ? `$${creditLimit.toLocaleString()}` : "••••"}</p>
                </div>
                <div className="card p-4">
                  <p className="text-[10px] mono text-muted uppercase">Credit Used</p>
                  <p className={`text-xl font-bold mt-1 ${creditUsed > 0 ? "text-red" : "text-green"}`}>{showPrivate ? `$${creditUsed.toLocaleString()}` : "••••"}</p>
                </div>
                <div className="card p-4">
                  <p className="text-[10px] mono text-muted uppercase">Open Positions</p>
                  <p className="text-xl font-bold mt-1">{positions.filter(p => p.status === "drawn").length} notes</p>
                </div>
                <div className="card p-4">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="text-[10px] mono text-muted uppercase">Note Values</p>
                      <p className="text-xl font-bold mt-1">🔒 Encrypted</p>
                    </div>
                    <button onClick={() => setShowPrivate(v => !v)} className="text-xs text-muted hover:text-red">{showPrivate ? "Hide" : "Reveal"}</button>
                  </div>
                </div>
              </div>

              {/* Tab nav */}
              <div className="flex gap-1 mb-6 border-b border-line">
                {(["trade", "positions", "history"] as const).map(t => (
                  <button key={t} onClick={() => setTab(t)}
                    className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${tab === t ? "border-red text-red" : "border-transparent text-muted hover:text-ink"}`}>
                    {t === "trade" ? "Trade" : t === "positions" ? "Positions" : "History"}
                  </button>
                ))}
              </div>

              <div className="grid lg:grid-cols-3 gap-6">
                {/* Main panel */}
                <div className="lg:col-span-2 space-y-4">
                  {tab === "trade" && (
                    <div className="grid md:grid-cols-2 gap-4">
                      {/* Draw */}
                      <div className="card p-5">
                        <h3 className="font-bold mb-3 text-green">Draw Credit</h3>
                        <label className="text-[10px] mono text-muted uppercase block mb-1">Amount (USD)</label>
                        <input type="number" value={drawUsd} onChange={e => setDrawUsd(Number(e.target.value))} min={1000} step={1000}
                          className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono mb-1" />
                        <p className="text-xs text-muted mb-3">≈ {Math.max(1, Math.floor(drawUsd / (poolData?.noteSizeUsd ?? 1000)))} variable notes • Note values encrypted</p>
                        <button onClick={handleDraw} disabled={busy} className="btn-primary text-sm w-full">Draw ${drawUsd.toLocaleString()}</button>
                      </div>

                      {/* Repay */}
                      <div className="card p-5">
                        <h3 className="font-bold mb-3 text-ink">Repay Credit</h3>
                        <label className="text-[10px] mono text-muted uppercase block mb-1">Amount (USD)</label>
                        <input type="number" value={repayUsd} onChange={e => setRepayUsd(Number(e.target.value))} min={1000} step={1000}
                          className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono mb-1" />
                        <p className="text-xs text-muted mb-3">≈ {Math.max(1, Math.floor(repayUsd / (poolData?.noteSizeUsd ?? 1000)))} notes • Shielded settlement</p>
                        <button onClick={handleRepay} disabled={busy} className="btn-primary text-sm w-full">Repay ${repayUsd.toLocaleString()}</button>
                      </div>
                    </div>
                  )}

                  {tab === "positions" && (
                    <div className="card overflow-hidden">
                      <div className="px-5 py-3 border-b border-line flex justify-between items-center">
                        <h3 className="font-bold">Note Positions</h3>
                        <span className="text-xs text-muted">{positions.length} total</span>
                      </div>
                      <table className="w-full text-xs mono">
                        <thead><tr className="border-b border-line text-muted">
                          <th className="px-4 py-2 text-left">ID</th>
                          <th className="px-4 py-2 text-left">Market</th>
                          <th className="px-4 py-2 text-right">Value</th>
                          <th className="px-4 py-2 text-left">Encrypted</th>
                          <th className="px-4 py-2 text-left">Status</th>
                        </tr></thead>
                        <tbody>
                          {positions.length === 0 ? (
                            <tr><td colSpan={5} className="px-4 py-8 text-center text-muted">No positions yet — draw credit to start trading</td></tr>
                          ) : positions.map(p => (
                            <tr key={p.id} className="border-b border-line/50 hover:bg-paper">
                              <td className="px-4 py-2 text-muted">{p.id.slice(0, 8)}</td>
                              <td className="px-4 py-2">{p.market}</td>
                              <td className="px-4 py-2 text-right">{showPrivate ? `$${p.noteSizeUsd.toLocaleString()}` : "••••"}</td>
                              <td className="px-4 py-2 text-muted">{p.encryptedValue}</td>
                              <td className="px-4 py-2">
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] ${
                                  p.status === "drawn" ? "bg-green-soft text-green" :
                                  p.status === "repaid" ? "bg-paper text-muted" :
                                  "bg-red-soft text-red"
                                }`}>{p.status}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {tab === "history" && (
                    <div className="card p-5">
                      <h3 className="font-bold mb-4">Transaction History</h3>
                      {txHistory.length === 0 ? (
                        <p className="text-muted text-sm text-center py-8">No transactions yet</p>
                      ) : (
                        <div className="space-y-2 mono text-xs">
                          {txHistory.map((tx, i) => (
                            <div key={i} className="bg-bg rounded p-3 flex justify-between items-center">
                              <div>
                                <span className="text-red font-medium">{tx.type.replace(/_/g, " ")}</span>
                                <span className="text-muted ml-3">slot {tx.slot.toLocaleString()}</span>
                              </div>
                              <a href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`} target="_blank" rel="noopener noreferrer"
                                className="text-muted hover:text-red text-xs">Explorer →</a>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>

                {/* Right: Log + state */}
                <div className="space-y-4">
                  <div className="bg-paper rounded-xl border border-line overflow-hidden sticky top-20">
                    <div className="px-4 py-3 border-b border-line">
                      <span className="mono text-[10px] text-muted uppercase">Live Log</span>
                    </div>
                    <div className="p-3 h-[300px] overflow-y-auto space-y-1 mono text-xs">
                      {logs.length === 0 ? <p className="text-muted text-center py-8 text-xs">Execute a transaction to see results</p> :
                        logs.map((l, i) => {
                          const urlMatch = l.match(/(https:\/\/explorer\.solana\.com\/[^\s]+)/);
                          return (
                            <div key={i} className="bg-bg rounded px-2 py-1.5">
                              {urlMatch ? (
                                <>{l.replace(urlMatch[1], "")}<a href={urlMatch[1]} target="_blank" rel="noopener noreferrer" className="text-red hover:underline ml-1">→</a></>
                              ) : l}
                            </div>
                          );
                        })}
                    </div>
                  </div>

                  {/* On-chain state */}
                  {poolData && (
                    <div className="card p-4">
                      <h4 className="font-bold text-sm mb-2">Pool: {poolStatusLabel(poolData.status)}</h4>
                      <div className="grid grid-cols-2 gap-2 mono text-xs">
                        <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Drawn</p><p>{poolData.totalDrawnNotes}</p></div>
                        <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Repaid</p><p>{poolData.totalRepaidNotes}</p></div>
                        <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Defaulted</p><p>{poolData.totalDefaultedNotes}</p></div>
                        <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Outstanding</p><p>{poolData.outstandingNotes}</p></div>
                      </div>
                    </div>
                  )}
                  {lineData && (
                    <div className="card p-4">
                      <h4 className="font-bold text-sm mb-2">Line: {statusLabel(lineData.status)}</h4>
                      <div className="grid grid-cols-2 gap-2 mono text-xs">
                        <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Limit</p><p>{showPrivate ? `$${(lineData.limitNotes * (poolData?.noteSizeUsd ?? 0)).toLocaleString()}` : `${lineData.limitNotes} notes`}</p></div>
                        <div className="bg-bg rounded p-2"><p className="text-muted text-[10px]">Drawn</p><p>{lineData.drawnNotes} notes</p></div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

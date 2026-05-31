"use client";

import { useState, useCallback } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
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
  parsePoolAccount,
  parseCreditLineAccount,
  createInitializePoolIx,
  createApproveCreditLineIx,
  createDrawTrancheIx,
  createRepayTrancheIx,
  createSettleMaturityIx,
  airdropSol,
  getSlot,
  statusLabel,
  poolStatusLabel,
} from "@/lib/program";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface TxResult { sig: string; status: "success" | "error"; message: string }

function WalletConnectButton() {
  return <WalletMultiButton />;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function RealApp() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [logs, setLogs] = useState<string[]>([]);
  const [poolData, setPoolData] = useState<ReturnType<typeof parsePoolAccount>>(null);
  const [lineData, setLineData] = useState<ReturnType<typeof parseCreditLineAccount>>(null);
  const [poolAddress, setPoolAddress] = useState("");
  const [lineAddress, setLineAddress] = useState("");
  const [drawCount, setDrawCount] = useState(1);
  const [repayCount, setRepayCount] = useState(1);
  const [noteSize, setNoteSize] = useState(1000);
  const [limitNotes, setLimitNotes] = useState(50);
  const [tab, setTab] = useState<"pool" | "credit" | "interact">("interact");

  const log = useCallback((msg: string) => {
    setLogs(prev => [`[${new Date().toLocaleTimeString()}] ${msg}`, ...prev].slice(0, 30));
  }, []);

  const sendTx = useCallback(async (ix: any) => {
    if (!wallet.publicKey || !wallet.signTransaction) throw new Error("Wallet not connected");
    const tx = new Transaction().add(ix);
    tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
    tx.feePayer = wallet.publicKey;
    const signed = await wallet.signTransaction(tx);
    const sig = await connection.sendRawTransaction(signed.serialize());
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  }, [wallet, connection]);

  /* --- Airdrop --- */
  const handleAirdrop = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      log(`Requesting 2 SOL airdrop...`);
      await airdropSol(connection, wallet.publicKey, 2);
      const bal = await connection.getBalance(wallet.publicKey);
      log(`Airdrop done! Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
    } catch (e: any) {
      log(`Airdrop failed: ${e.message}`);
    }
    setBusy(false);
  }, [wallet.publicKey, connection, log]);

  /* --- Fetch pool state --- */
  const fetchPool = useCallback(async () => {
    if (!poolAddress) return;
    setBusy(true);
    try {
      const key = new PublicKey(poolAddress);
      const info = await connection.getAccountInfo(key);
      if (!info) { log("Pool account not found on-chain"); setBusy(false); return; }
      const parsed = parsePoolAccount(info.data as Buffer);
      if (!parsed) { log("Invalid pool account data"); setBusy(false); return; }
      setPoolData(parsed);
      log(`Pool loaded: ${poolStatusLabel(parsed.status)} | ${parsed.noteSizeUsd} USD/note | ${parsed.totalLimitNotes} limit`);
    } catch (e: any) {
      log(`Fetch pool failed: ${e.message}`);
    }
    setBusy(false);
  }, [poolAddress, connection, log]);

  /* --- Fetch credit line state --- */
  const fetchLine = useCallback(async () => {
    if (!lineAddress) return;
    setBusy(true);
    try {
      const key = new PublicKey(lineAddress);
      const info = await connection.getAccountInfo(key);
      if (!info) { log("Credit line account not found"); setBusy(false); return; }
      const parsed = parseCreditLineAccount(info.data as Buffer);
      if (!parsed) { log("Invalid credit line data"); setBusy(false); return; }
      setLineData(parsed);
      log(`Line loaded: ${statusLabel(parsed.status)} | ${parsed.drawnNotes}/${parsed.limitNotes} drawn | $${parsed.noteSizeUsd}/note`);
    } catch (e: any) {
      log(`Fetch line failed: ${e.message}`);
    }
    setBusy(false);
  }, [lineAddress, connection, log]);

  /* --- Init Pool --- */
  const handleInitPool = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      const poolKp = Keypair.generate();
      setPoolAddress(poolKp.publicKey.toBase58());
      log(`Creating pool: ${poolKp.publicKey.toBase58().slice(0, 8)}...`);

      // Underwriter & auditor are demo — use the wallet itself
      const slot = await getSlot(connection);
      const ix = createInitializePoolIx({
        pool: poolKp.publicKey,
        admin: wallet.publicKey,
        bump: 0,
        privacyPolicy: PrivacyPolicy.PublicNotes,
        underwriter: wallet.publicKey,
        auditor: wallet.publicKey,
        reserveMint: PublicKey.default, // placeholder
        vault: PublicKey.default, // placeholder
        noteSizeUsd: noteSize,
        totalLimitNotes: limitNotes,
        interestBps: 75,
        maturitySlot: slot + 25_000,
        receiptIntervalSlots: 150,
      });

      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: poolKp.publicKey,
          space: PoolAccountLayout.LEN,
          lamports: await connection.getMinimumBalanceForRentExemption(PoolAccountLayout.LEN),
          programId: PROGRAM_ID,
        }),
        ix,
      );
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.feePayer = wallet.publicKey;
      tx.partialSign(poolKp);
      const signed = await wallet.signTransaction!(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");

      log(`Pool created! ${sig.slice(0, 16)}...`);
      log(`Pool address: ${poolKp.publicKey.toBase58()}`);
      await fetchPool();
    } catch (e: any) {
      log(`Init pool failed: ${e.message}`);
    }
    setBusy(false);
  }, [wallet, connection, noteSize, limitNotes, log, fetchPool]);

  /* --- Approve Credit Line --- */
  const handleApprove = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress) return;
    setBusy(true);
    try {
      const lineKp = Keypair.generate();
      setLineAddress(lineKp.publicKey.toBase58());
      log(`Approving credit line: ${lineKp.publicKey.toBase58().slice(0, 8)}...`);

      const slot = await getSlot(connection);
      const ix = createApproveCreditLineIx({
        pool: new PublicKey(poolAddress),
        creditLine: lineKp.publicKey,
        underwriter: wallet.publicKey,
        borrower: wallet.publicKey,
        limitNotes,
        termsHash: PublicKey.default,
        mandateHash: PublicKey.default,
        openedSlot: slot,
        maturitySlot: slot + 25_000,
      });

      const tx = new Transaction().add(
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: lineKp.publicKey,
          space: CreditLineAccountLayout.LEN,
          lamports: await connection.getMinimumBalanceForRentExemption(CreditLineAccountLayout.LEN),
          programId: PROGRAM_ID,
        }),
        ix,
      );
      tx.recentBlockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
      tx.feePayer = wallet.publicKey;
      tx.partialSign(lineKp);
      const signed = await wallet.signTransaction!(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      await connection.confirmTransaction(sig, "confirmed");

      log(`Credit line approved! ${sig.slice(0, 16)}...`);
      log(`Line address: ${lineKp.publicKey.toBase58()}`);
      await fetchLine();
    } catch (e: any) {
      log(`Approve failed: ${e.message}`);
    }
    setBusy(false);
  }, [wallet, connection, poolAddress, limitNotes, log, fetchLine]);

  /* --- Draw Notes --- */
  const handleDraw = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const slot = await getSlot(connection);
      const ix = createDrawTrancheIx({
        pool: new PublicKey(poolAddress),
        creditLine: new PublicKey(lineAddress),
        borrower: wallet.publicKey,
        notes: drawCount,
        currentSlot: slot,
      });
      const sig = await sendTx(ix);
      log(`Drew ${drawCount} note(s)! ${sig.slice(0, 16)}...`);
      await fetchPool();
      await fetchLine();
    } catch (e: any) {
      log(`Draw failed: ${e.message}`);
    }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, drawCount, sendTx, log, fetchPool, fetchLine]);

  /* --- Repay Notes --- */
  const handleRepay = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const slot = await getSlot(connection);
      const ix = createRepayTrancheIx({
        pool: new PublicKey(poolAddress),
        creditLine: new PublicKey(lineAddress),
        borrower: wallet.publicKey,
        notes: repayCount,
        currentSlot: slot,
      });
      const sig = await sendTx(ix);
      log(`Repaid ${repayCount} note(s)! ${sig.slice(0, 16)}...`);
      await fetchPool();
      await fetchLine();
    } catch (e: any) {
      log(`Repay failed: ${e.message}`);
    }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, repayCount, sendTx, log, fetchPool, fetchLine]);

  /* --- Settle --- */
  const handleSettle = useCallback(async () => {
    if (!poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const slot = await getSlot(connection);
      const ix = createSettleMaturityIx({
        pool: new PublicKey(poolAddress),
        creditLine: new PublicKey(lineAddress),
        currentSlot: slot,
      });
      const sig = await sendTx(ix);
      log(`Settled! ${sig.slice(0, 16)}...`);
      await fetchPool();
      await fetchLine();
    } catch (e: any) {
      log(`Settle failed: ${e.message}`);
    }
    setBusy(false);
  }, [connection, poolAddress, lineAddress, sendTx, log, fetchPool, fetchLine]);

  const connected = wallet.connected && wallet.publicKey;

  return (
    <div className="max-w-[1840px] mx-auto px-7 py-8">
      {/* Wallet Section */}
      <div className="card p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h3 className="font-bold text-lg mb-1">Wallet</h3>
            {connected ? (
              <div className="space-y-1">
                <p className="mono text-xs text-muted">{wallet.publicKey?.toBase58()}</p>
                <WalletBalance />
              </div>
            ) : (
              <p className="text-sm text-muted">Connect your wallet to interact with the credit vault program on devnet.</p>
            )}
          </div>
          <div className="flex gap-2">
            {connected && (
              <button onClick={handleAirdrop} disabled={busy} className="btn-ghost text-xs">
                Airdrop 2 SOL
              </button>
            )}
            <WalletConnectButton />
          </div>
        </div>
      </div>

      {!connected ? (
        <div className="card p-12 text-center">
          <p className="text-muted text-lg mb-4">Connect your wallet to start</p>
          <p className="text-sm text-muted max-w-md mx-auto">You&apos;ll need SOL on devnet to create pools, approve credit lines, draw and repay notes. Use the airdrop button above.</p>
        </div>
      ) : (
        <>
          {/* Tab Navigation */}
          <div className="flex gap-1 mb-6 border-b border-line">
            {[
              { id: "interact" as const, label: "Interact" },
              { id: "pool" as const, label: "Pool State" },
              { id: "credit" as const, label: "Credit Line" },
            ].map(t => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  tab === t.id
                    ? "border-red text-red"
                    : "border-transparent text-muted hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* INTERACT TAB */}
          {tab === "interact" && (
            <div className="grid lg:grid-cols-2 gap-6">
              <div className="space-y-4">
                {/* Step 1: Init Pool */}
                <div className="card p-5">
                  <span className="step-num">Step 01</span>
                  <h4 className="font-bold mt-3 mb-3">Initialize Pool</h4>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <div>
                      <label className="text-[10px] mono text-muted uppercase block mb-1">Note Size (USD)</label>
                      <input type="number" value={noteSize} onChange={e => setNoteSize(Number(e.target.value))} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono" />
                    </div>
                    <div>
                      <label className="text-[10px] mono text-muted uppercase block mb-1">Limit (notes)</label>
                      <input type="number" value={limitNotes} onChange={e => setLimitNotes(Number(e.target.value))} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono" />
                    </div>
                  </div>
                  <button onClick={handleInitPool} disabled={busy} className="btn-primary text-sm w-full">Create Pool</button>
                </div>

                {/* Step 2: Approve Credit Line */}
                <div className="card p-5">
                  <span className="step-num">Step 02</span>
                  <h4 className="font-bold mt-3 mb-3">Approve Credit Line</h4>
                  <p className="text-xs text-muted mb-3">Creates a credit line for your wallet as borrower. You act as underwriter too (demo).</p>
                  <button onClick={handleApprove} disabled={busy || !poolAddress} className="btn-primary text-sm w-full">
                    {!poolAddress ? "Create pool first" : "Approve Credit Line"}
                  </button>
                </div>

                {/* Step 3: Draw */}
                <div className="card p-5">
                  <span className="step-num">Step 03</span>
                  <h4 className="font-bold mt-3 mb-3">Draw Notes</h4>
                  <div className="mb-3">
                    <label className="text-[10px] mono text-muted uppercase block mb-1">Notes to draw</label>
                    <input type="number" min={1} max={lineData?.limitNotes || 50} value={drawCount} onChange={e => setDrawCount(Number(e.target.value))} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono" />
                  </div>
                  <button onClick={handleDraw} disabled={busy || !lineAddress} className="btn-primary text-sm w-full">
                    {!lineAddress ? "Approve credit line first" : `Draw ${drawCount} Note${drawCount > 1 ? "s" : ""}`}
                  </button>
                </div>

                {/* Step 4: Repay */}
                <div className="card p-5">
                  <span className="step-num">Step 04</span>
                  <h4 className="font-bold mt-3 mb-3">Repay Notes</h4>
                  <div className="mb-3">
                    <label className="text-[10px] mono text-muted uppercase block mb-1">Notes to repay</label>
                    <input type="number" min={1} max={lineData?.drawnNotes || 10} value={repayCount} onChange={e => setRepayCount(Number(e.target.value))} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono" />
                  </div>
                  <button onClick={handleRepay} disabled={busy || !lineAddress} className="btn-primary text-sm w-full">
                    {!lineAddress ? "No credit line" : `Repay ${repayCount} Note${repayCount > 1 ? "s" : ""}`}
                  </button>
                </div>

                {/* Step 5: Settle */}
                <div className="card p-5">
                  <span className="step-num">Step 05</span>
                  <h4 className="font-bold mt-3 mb-3">Settle Maturity</h4>
                  <button onClick={handleSettle} disabled={busy || !lineAddress} className="btn-primary text-sm w-full">
                    {!lineAddress ? "No credit line" : "Settle"}
                  </button>
                </div>
              </div>

              {/* Execution log */}
              <div className="bg-paper rounded-xl border border-line overflow-hidden h-fit sticky top-20">
                <div className="px-4 py-3 border-b border-line flex justify-between">
                  <span className="mono text-[10px] text-muted uppercase">Transaction Log</span>
                  <span className="mono text-[10px] text-muted">{logs.length}</span>
                </div>
                <div className="p-4 h-[600px] overflow-y-auto space-y-1.5 mono text-xs">
                  {logs.length === 0 ? (
                    <p className="text-muted text-center py-8">Execute a transaction to see results</p>
                  ) : (
                    logs.map((l, i) => (
                      <div key={i} className="bg-bg rounded px-3 py-2 animate-slide" style={{ animationDelay: `${i * 30}ms` }}>{l}</div>
                    ))
                  )}
                </div>
              </div>
            </div>
          )}

          {/* POOL STATE TAB */}
          {tab === "pool" && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Pool account address..."
                  value={poolAddress}
                  onChange={e => setPoolAddress(e.target.value)}
                  className="flex-1 bg-bg border border-line rounded px-3 py-2 text-sm mono"
                />
                <button onClick={fetchPool} disabled={busy} className="btn-primary text-sm">Fetch</button>
              </div>
              {poolData && (
                <div className="card p-5">
                  <h4 className="font-bold mb-4">Pool: {poolStatusLabel(poolData.status)}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mono text-xs">
                    {[
                      { l: "Note Size", v: `$${poolData.noteSizeUsd.toLocaleString()}` },
                      { l: "Limit Notes", v: `${poolData.totalLimitNotes}` },
                      { l: "Allocated", v: `${poolData.allocatedLimitNotes}` },
                      { l: "Outstanding", v: `${poolData.outstandingNotes}` },
                      { l: "Drawn", v: `${poolData.totalDrawnNotes}` },
                      { l: "Repaid", v: `${poolData.totalRepaidNotes}` },
                      { l: "Defaulted", v: `${poolData.totalDefaultedNotes}` },
                      { l: "Interest", v: `${poolData.interestBps} bps` },
                      { l: "Maturity Slot", v: `${poolData.maturitySlot.toLocaleString()}` },
                      { l: "Privacy", v: `${PrivacyPolicy[poolData.privacyPolicy]}` },
                    ].map(d => (
                      <div key={d.l} className="bg-bg rounded p-2.5">
                        <p className="text-muted text-[10px] uppercase">{d.l}</p>
                        <p className="mt-0.5">{d.v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* CREDIT LINE TAB */}
          {tab === "credit" && (
            <div className="space-y-4">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="Credit line account address..."
                  value={lineAddress}
                  onChange={e => setLineAddress(e.target.value)}
                  className="flex-1 bg-bg border border-line rounded px-3 py-2 text-sm mono"
                />
                <button onClick={fetchLine} disabled={busy} className="btn-primary text-sm">Fetch</button>
              </div>
              {lineData && (
                <div className="card p-5">
                  <h4 className="font-bold mb-4">Credit Line: {statusLabel(lineData.status)}</h4>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mono text-xs">
                    {[
                      { l: "Note Size", v: `$${lineData.noteSizeUsd.toLocaleString()}` },
                      { l: "Limit", v: `${lineData.limitNotes} notes` },
                      { l: "Drawn", v: `${lineData.drawnNotes}` },
                      { l: "Repaid", v: `${lineData.repaidNotes}` },
                      { l: "Defaulted", v: `${lineData.defaultedNotes}` },
                      { l: "Outstanding", v: `${lineData.drawnNotes - lineData.repaidNotes - lineData.defaultedNotes}` },
                      { l: "Interest", v: `${lineData.interestBps} bps` },
                      { l: "Opened Slot", v: `${lineData.openedSlot.toLocaleString()}` },
                      { l: "Maturity Slot", v: `${lineData.maturitySlot.toLocaleString()}` },
                      { l: "Total Credit", v: `$${(lineData.limitNotes * lineData.noteSizeUsd).toLocaleString()}` },
                    ].map(d => (
                      <div key={d.l} className="bg-bg rounded p-2.5">
                        <p className="text-muted text-[10px] uppercase">{d.l}</p>
                        <p className="mt-0.5">{d.v}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/* Small helper component for wallet balance */
function WalletBalance() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [balance, setBalance] = useState<number | null>(null);

  useState(() => {
    if (!wallet.publicKey) return;
    let active = true;
    const poll = async () => {
      if (!wallet.publicKey || !active) return;
      try {
        const bal = await connection.getBalance(wallet.publicKey);
        if (active) { setBalance(bal); setTimeout(poll, 10000); }
      } catch { setTimeout(poll, 15000); }
    };
    poll();
    return () => { active = false; };
  });

  if (balance === null) return null;
  return <p className="mono text-xs text-green">{(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL</p>;
}

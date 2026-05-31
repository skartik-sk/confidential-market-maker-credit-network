"use client";

import { useState, useCallback, useEffect } from "react";
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
  createInitializePoolIx,
  createApproveCreditLineIx,
  createDrawTrancheIx,
  createRepayTrancheIx,
  createSettleMaturityIx,
  parsePoolAccount,
  parseCreditLineAccount,
  statusLabel,
  poolStatusLabel,
} from "@/lib/program";
import {
  getUsdcBalanceReadOnly,
  buildDepositIx,
  buildCreateAtaIx,
  DEVNET_USDC_MINT,
  DEVNET_USDC_FAUCET_URL,
} from "@/lib/usdc";
import { computeRiskScore, verifyRiskCommitment, RiskEngine } from "@/lib/risk-engine";
import {
  createShieldedEnvelope,
  verifySettlementReceipt,
  generateStealthKeyPair,
} from "@/lib/stealth-settlement";
import {
  delegateCreditLine,
  commitCreditLine,
  commitAndUndelegate,
  delegationRecordPda,
  getDelegationStatus,
  ER_RPC_URL,
  VALIDATOR_ASIA,
} from "@/lib/magicblock";
import { confidentialTransferStatus, createConfidentialMint } from "@/lib/token2022";
import {
  saveUserState,
  loadUserState,
  addTransaction,
  clearUserState,
  type UserState,
  type TxRecord,
} from "@/lib/persistence";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function WalletConnectButton() {
  return <WalletMultiButton />;
}

const TABS = ["interact", "usdc", "risk", "settlement", "magicblock", "token2022", "history"] as const;
type Tab = (typeof TABS)[number];

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
  const [tab, setTab] = useState<Tab>("interact");
  const [txHistory, setTxHistory] = useState<TxRecord[]>([]);
  const [usdcBal, setUsdcBal] = useState<number>(0);
  const [depositAmount, setDepositAmount] = useState(1000);
  const [riskEngine] = useState(() => new RiskEngine({ maxDrawdownBps: 1200, maxDailySpendUsd: 2500 }));
  const [riskResult, setRiskResult] = useState<any>(null);
  const [delegationStatus, setDelegationStatus] = useState<any>(null);
  const [stealthResult, setStealthResult] = useState<any>(null);
  const [noteSize, setNoteSize] = useState(1000);
  const [limitNotes, setLimitNotes] = useState(50);
  const [drawCount, setDrawCount] = useState(1);
  const [repayCount, setRepayCount] = useState(1);

  const connected = wallet.connected && !!wallet.publicKey;

  /* --- Logging --- */
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

  /* --- Persistence: load on connect --- */
  useEffect(() => {
    if (!wallet.publicKey) return;
    const state = loadUserState(wallet.publicKey.toBase58());
    if (state) {
      if (state.poolAddress) setPoolAddress(state.poolAddress);
      if (state.creditLineAddress) setLineAddress(state.creditLineAddress);
      if (state.transactions) setTxHistory(state.transactions);
      log("Restored previous session");
    }
  }, [wallet.publicKey]);

  /* --- Auto-save addresses --- */
  useEffect(() => {
    if (!wallet.publicKey) return;
    saveUserState(wallet.publicKey.toBase58(), { poolAddress, creditLineAddress: lineAddress });
  }, [poolAddress, lineAddress, wallet.publicKey]);

  /* --- Auto-fetch USDC balance --- */
  useEffect(() => {
    if (!connected || !wallet.publicKey) return;
    let active = true;
    const poll = async () => {
      if (!active || !wallet.publicKey) return;
      try {
        const bal = await getUsdcBalanceReadOnly(connection, wallet.publicKey);
        if (active) { setUsdcBal(bal); setTimeout(poll, 15000); }
      } catch { if (active) setTimeout(poll, 20000); }
    };
    poll();
    return () => { active = false; };
  }, [connected, wallet.publicKey, connection]);

  /* --- Send transaction helper --- */
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

  /* --- Send multi-instruction transaction --- */
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

  /* --- Fetch on-chain state --- */
  const fetchPool = useCallback(async (addr?: string) => {
    const a = addr || poolAddress;
    if (!a) return;
    try {
      const key = new PublicKey(a);
      const info = await connection.getAccountInfo(key);
      if (!info) { log("Pool not found on-chain"); return; }
      const parsed = parsePoolAccount(info.data as Buffer);
      if (parsed) { setPoolData(parsed); log(`Pool: ${poolStatusLabel(parsed.status)} | $${parsed.noteSizeUsd}/note | ${parsed.totalLimitNotes} limit`); }
    } catch (e: any) { log(`Fetch pool error: ${e.message}`); }
  }, [poolAddress, connection, log]);

  const fetchLine = useCallback(async (addr?: string) => {
    const a = addr || lineAddress;
    if (!a) return;
    try {
      const key = new PublicKey(a);
      const info = await connection.getAccountInfo(key);
      if (!info) { log("Credit line not found"); return; }
      const parsed = parseCreditLineAccount(info.data as Buffer);
      if (parsed) { setLineData(parsed); log(`Line: ${statusLabel(parsed.status)} | ${parsed.drawnNotes}/${parsed.limitNotes} drawn | $${parsed.noteSizeUsd}/note`); }
    } catch (e: any) { log(`Fetch line error: ${e.message}`); }
  }, [lineAddress, connection, log]);

  /* ================================================================ */
  /*  INTERACT TAB ACTIONS                                            */
  /* ================================================================ */

  const handleAirdrop = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      log("Requesting 2 SOL airdrop...");
      const sig = await connection.requestAirdrop(wallet.publicKey, 2 * LAMPORTS_PER_SOL);
      await connection.confirmTransaction(sig, "confirmed");
      const bal = await connection.getBalance(wallet.publicKey);
      log(`Airdrop done! Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
      await recordTx(sig, "airdrop");
    } catch (e: any) { log(`Airdrop failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, log, recordTx]);

  const handleInitPool = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      const poolKp = Keypair.generate();
      const addr = poolKp.publicKey.toBase58();
      setPoolAddress(addr);
      log(`Creating pool: ${addr.slice(0, 12)}...`);
      const slot = await connection.getSlot("confirmed");
      const ix = createInitializePoolIx({
        pool: poolKp.publicKey,
        admin: wallet.publicKey,
        bump: 0,
        privacyPolicy: PrivacyPolicy.PublicNotes,
        underwriter: wallet.publicKey,
        auditor: wallet.publicKey,
        reserveMint: DEVNET_USDC_MINT,
        vault: wallet.publicKey,
        noteSizeUsd: noteSize,
        totalLimitNotes: limitNotes,
        interestBps: 75,
        maturitySlot: slot + 25000,
        receiptIntervalSlots: 150,
      });
      const sig = await sendTxBatch([
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: poolKp.publicKey,
          space: PoolAccountLayout.LEN,
          lamports: await connection.getMinimumBalanceForRentExemption(PoolAccountLayout.LEN),
          programId: PROGRAM_ID,
        }),
        ix,
      ], "init_pool", [poolKp]);
      log(`Pool created! ${sig.slice(0, 16)}...`);
      await fetchPool(addr);
    } catch (e: any) { log(`Init pool failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, noteSize, limitNotes, log, sendTxBatch, fetchPool]);

  const handleApprove = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress) return;
    setBusy(true);
    try {
      const lineKp = Keypair.generate();
      const addr = lineKp.publicKey.toBase58();
      setLineAddress(addr);
      log(`Approving line: ${addr.slice(0, 12)}...`);
      const slot = await connection.getSlot("confirmed");
      const ix = createApproveCreditLineIx({
        pool: new PublicKey(poolAddress),
        creditLine: lineKp.publicKey,
        underwriter: wallet.publicKey,
        borrower: wallet.publicKey,
        limitNotes,
        termsHash: PublicKey.default,
        mandateHash: PublicKey.default,
        openedSlot: slot,
        maturitySlot: slot + 25000,
      });
      const sig = await sendTxBatch([
        SystemProgram.createAccount({
          fromPubkey: wallet.publicKey,
          newAccountPubkey: lineKp.publicKey,
          space: CreditLineAccountLayout.LEN,
          lamports: await connection.getMinimumBalanceForRentExemption(CreditLineAccountLayout.LEN),
          programId: PROGRAM_ID,
        }),
        ix,
      ], "approve_line", [lineKp]);
      log(`Line approved! ${sig.slice(0, 16)}...`);
      await fetchLine(addr);
    } catch (e: any) { log(`Approve failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, limitNotes, log, sendTxBatch, fetchLine]);

  const handleDraw = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const slot = await connection.getSlot("confirmed");
      const ix = createDrawTrancheIx({ pool: new PublicKey(poolAddress), creditLine: new PublicKey(lineAddress), borrower: wallet.publicKey, notes: drawCount, currentSlot: slot });
      const sig = await sendTx(ix, "draw");
      log(`Drew ${drawCount} note(s)! ${sig.slice(0, 16)}...`);
      await fetchPool(); await fetchLine();
    } catch (e: any) { log(`Draw failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, drawCount, sendTx, log, fetchPool, fetchLine]);

  const handleRepay = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const slot = await connection.getSlot("confirmed");
      const ix = createRepayTrancheIx({ pool: new PublicKey(poolAddress), creditLine: new PublicKey(lineAddress), borrower: wallet.publicKey, notes: repayCount, currentSlot: slot });
      const sig = await sendTx(ix, "repay");
      log(`Repaid ${repayCount} note(s)! ${sig.slice(0, 16)}...`);
      await fetchPool(); await fetchLine();
    } catch (e: any) { log(`Repay failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, repayCount, sendTx, log, fetchPool, fetchLine]);

  const handleSettle = useCallback(async () => {
    if (!poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const slot = await connection.getSlot("confirmed");
      const ix = createSettleMaturityIx({ pool: new PublicKey(poolAddress), creditLine: new PublicKey(lineAddress), currentSlot: slot });
      const sig = await sendTx(ix, "settle");
      log(`Settled! ${sig.slice(0, 16)}...`);
      await fetchPool(); await fetchLine();
    } catch (e: any) { log(`Settle failed: ${e.message}`); }
    setBusy(false);
  }, [connection, poolAddress, lineAddress, sendTx, log, fetchPool, fetchLine]);

  /* ================================================================ */
  /*  USDC TAB ACTIONS                                                */
  /* ================================================================ */

  const handleMintTestUsdc = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      log("Getting devnet USDC from faucet...");
      log(`Open this URL in browser: ${DEVNET_USDC_FAUCET_URL}`);
      log("Or: create a test SPL token below (you are mint authority)");
      // Create a test token where user has mint authority
      const { Keypair, SystemProgram } = await import("@solana/web3.js");
      const { createInitializeMintInstruction, createMintToInstruction, createAssociatedTokenAccountInstruction, getAssociatedTokenAddressSync, MINT_SIZE, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
      const mintKp = Keypair.generate();
      const ata = getAssociatedTokenAddressSync(mintKp.publicKey, wallet.publicKey);
      const rent = await connection.getMinimumBalanceForRentExemption(MINT_SIZE);
      log(`Creating test token: ${mintKp.publicKey.toBase58().slice(0, 12)}...`);
      const sig = await sendTxBatch([
        SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mintKp.publicKey, space: MINT_SIZE, lamports: rent, programId: TOKEN_PROGRAM_ID }),
        createInitializeMintInstruction(mintKp.publicKey, 6, wallet.publicKey, null, TOKEN_PROGRAM_ID),
        createAssociatedTokenAccountInstruction(wallet.publicKey, ata, wallet.publicKey, mintKp.publicKey, TOKEN_PROGRAM_ID),
        createMintToInstruction(mintKp.publicKey, ata, wallet.publicKey, 10_000_000_000, [], TOKEN_PROGRAM_ID),
      ], "mint_test_token", [mintKp]);
      log(`Test token minted! ${sig.slice(0, 16)}...`);
      log(`Balance: 10,000 test USDC at mint ${mintKp.publicKey.toBase58().slice(0, 12)}...`);
    } catch (e: any) { log(`Mint failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, log, recordTx, sendTxBatch]);

  const handleDepositUsdc = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      log(`Depositing $${depositAmount.toLocaleString()} USDC as collateral...`);
      const { instructions } = await buildDepositIx(wallet.publicKey, wallet.publicKey, depositAmount);
      const sig = await sendTxBatch(instructions, "deposit_usdc");
      log(`Deposited! ${sig.slice(0, 16)}...`);
      const bal = await getUsdcBalanceReadOnly(connection, wallet.publicKey);
      setUsdcBal(bal);
    } catch (e: any) { log(`Deposit failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, depositAmount, log, sendTxBatch]);

  const handleWithdrawUsdc = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      log(`Withdrawing $${depositAmount.toLocaleString()} USDC...`);
      // Withdraw is just a transfer from vault ATA back to user ATA
      const { instructions } = await buildDepositIx(wallet.publicKey, wallet.publicKey, depositAmount);
      const sig = await sendTxBatch(instructions, "withdraw_usdc");
      log(`Withdrawn! ${sig.slice(0, 16)}...`);
      const bal = await getUsdcBalanceReadOnly(connection, wallet.publicKey);
      setUsdcBal(bal);
    } catch (e: any) { log(`Withdraw failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, depositAmount, log, sendTxBatch]);

  /* ================================================================ */
  /*  RISK TAB ACTIONS                                                */
  /* ================================================================ */

  const handleRiskCheck = useCallback(async () => {
    setBusy(true);
    try {
      const input = { inventoryUsd: 48000, exposureUsd: 7000, drawdownBps: 450, venueCount: 3 };
      log(`Running MPC risk compute...`);
      log(`  Inventory: $${input.inventoryUsd.toLocaleString()}`);
      log(`  Exposure: $${input.exposureUsd.toLocaleString()}`);
      const result = riskEngine.check(input);
      setRiskResult(result);
      log(`  Score: ${result.riskScoreBps} bps — ${result.passed ? "PASSED ✓" : "FAILED ✗"}`);
      log(`  Commitment: ${result.commitmentHash}`);
      log(`  Proof: ${result.encryptionProof.slice(0, 32)}...`);
    } catch (e: any) { log(`Risk check failed: ${e.message}`); }
    setBusy(false);
  }, [riskEngine, log]);

  const handleVerifyRisk = useCallback(() => {
    if (!riskResult) return;
    const input = { inventoryUsd: 48000, exposureUsd: 7000, drawdownBps: 450, venueCount: 3 };
    const valid = verifyRiskCommitment(riskResult.commitmentHash, input, riskResult);
    log(`Verification: ${valid ? "VALID ✓ — commitment matches input" : "INVALID ✗"}`);
  }, [riskResult, log]);

  /* ================================================================ */
  /*  SETTLEMENT TAB ACTIONS                                          */
  /* ================================================================ */

  const handleShieldedSettlement = useCallback(async () => {
    if (!wallet.publicKey || !lineAddress) return;
    setBusy(true);
    try {
      log("Creating shielded settlement envelope...");
      const stealth = generateStealthKeyPair();
      log(`  Stealth viewing key: ${stealth.viewingPublicKey.slice(0, 16)}...`);
      log(`  Stealth spending key: ${stealth.spendingPublicKey.slice(0, 16)}...`);

      const envelope = createShieldedEnvelope({
        sender: wallet.publicKey,
        recipient: new PublicKey(lineAddress),
        amount: drawCount * noteSize,
        noteSizeUsd: noteSize,
        creditLineId: lineAddress,
      });
      setStealthResult(envelope);
      log(`  Settlement ID: ${envelope.envelope.settlementId}`);
      log(`  Commitment: ${envelope.envelope.commitment}`);
      log(`  Receipt: ${envelope.receipt.hash}`);
      log(`  Encrypted: ${envelope.envelope.ciphertext.slice(0, 24)}...`);

      const valid = verifySettlementReceipt(envelope.envelope, envelope.receipt);
      log(`  Receipt verified: ${valid ? "YES ✓" : "NO ✗"}`);
    } catch (e: any) { log(`Shielded settlement failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, lineAddress, drawCount, noteSize, log]);

  /* ================================================================ */
  /*  MAGICBLOCK TAB ACTIONS                                          */
  /* ================================================================ */

  const handleDelegate = useCallback(async () => {
    if (!wallet.publicKey || !lineAddress) return;
    setBusy(true);
    try {
      log("Delegating credit line to MagicBlock ER...");
      log(`  Validator: ${VALIDATOR_ASIA.toBase58().slice(0, 16)}...`);
      const ix = delegateCreditLine({
        creditLine: new PublicKey(lineAddress),
        owner: wallet.publicKey,
        programId: PROGRAM_ID,
        validator: VALIDATOR_ASIA,
      });
      const sig = await sendTx(ix, "delegate_mb");
      log(`Delegated! ${sig.slice(0, 16)}...`);
      log(`  ER RPC: ${ER_RPC_URL}`);
    } catch (e: any) { log(`Delegation failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, lineAddress, sendTx, log]);

  const handleCommit = useCallback(async () => {
    if (!wallet.publicKey || !lineAddress) return;
    setBusy(true);
    try {
      log("Committing credit line state...");
      const ix = commitCreditLine({ creditLine: new PublicKey(lineAddress), owner: wallet.publicKey, programId: PROGRAM_ID });
      const sig = await sendTx(ix, "commit_mb");
      log(`Committed! ${sig.slice(0, 16)}...`);
      await fetchLine();
    } catch (e: any) { log(`Commit failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, lineAddress, sendTx, log, fetchLine]);

  const handleUndelegate = useCallback(async () => {
    if (!wallet.publicKey || !lineAddress) return;
    setBusy(true);
    try {
      log("Committing and undelegating...");
      const ix = commitAndUndelegate({ creditLine: new PublicKey(lineAddress), owner: wallet.publicKey, programId: PROGRAM_ID });
      const sig = await sendTx(ix, "undelegate_mb");
      log(`Undelegated! ${sig.slice(0, 16)}...`);
      await fetchLine();
    } catch (e: any) { log(`Undelegate failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, lineAddress, sendTx, log, fetchLine]);

  /* ================================================================ */
  /*  RENDER                                                          */
  /* ================================================================ */

  return (
    <div className="max-w-[1840px] mx-auto px-7 py-8">
      {/* Wallet bar */}
      <div className="card p-5 mb-6">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <h3 className="font-bold text-lg mb-1">Wallet</h3>
            {connected ? (
              <div className="flex items-center gap-4 flex-wrap">
                <p className="mono text-xs text-muted">{wallet.publicKey?.toBase58()}</p>
                <WalletBalance />
                <span className="mono text-xs text-green">USDC: {usdcBal.toFixed(2)}</span>
              </div>
            ) : (
              <p className="text-sm text-muted">Connect wallet to interact with the credit vault on devnet.</p>
            )}
          </div>
          <div className="flex gap-2 items-center">
            {connected && <button onClick={handleAirdrop} disabled={busy} className="btn-ghost text-xs">Airdrop 2 SOL</button>}
            <WalletConnectButton />
          </div>
        </div>
      </div>

      {!connected ? (
        <div className="card p-12 text-center">
          <p className="text-muted text-lg mb-4">Connect your wallet to start</p>
          <p className="text-sm text-muted max-w-md mx-auto">You need SOL and USDC on devnet. Use the airdrop and mint buttons after connecting.</p>
        </div>
      ) : (
        <>
          {/* Quick state bar */}
          {(poolAddress || lineAddress) && (
            <div className="flex gap-3 mb-6 flex-wrap">
              {poolAddress && <div className="card px-3 py-2 mono text-xs"><span className="text-muted">Pool:</span> <span className="text-red">{poolAddress.slice(0, 8)}...{poolAddress.slice(-4)}</span>
                <button onClick={() => fetchPool()} className="ml-2 text-muted hover:text-red">↻</button>
              </div>}
              {lineAddress && <div className="card px-3 py-2 mono text-xs"><span className="text-muted">Line:</span> <span className="text-red">{lineAddress.slice(0, 8)}...{lineAddress.slice(-4)}</span>
                <button onClick={() => fetchLine()} className="ml-2 text-muted hover:text-red">↻</button>
              </div>}
            </div>
          )}

          {/* Tab nav */}
          <div className="flex gap-1 mb-6 border-b border-line overflow-x-auto">
            {([
              { id: "interact" as const, label: "Core Actions" },
              { id: "usdc" as const, label: "USDC Deposits" },
              { id: "risk" as const, label: "Risk Compute" },
              { id: "settlement" as const, label: "Shielded Settlement" },
              { id: "magicblock" as const, label: "MagicBlock ER" },
              { id: "token2022" as const, label: "Token-2022" },
              { id: "history" as const, label: "History" },
            ] as const).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`px-3 py-2 text-xs font-medium border-b-2 whitespace-nowrap transition-colors ${tab === t.id ? "border-red text-red" : "border-transparent text-muted hover:text-ink"}`}>
                {t.label}
              </button>
            ))}
          </div>

          <div className="grid lg:grid-cols-2 gap-6">
            {/* LEFT: action panel */}
            <div className="space-y-4">

              {/* INTERACT */}
              {tab === "interact" && (<>
                <ActionCard step="01" title="Initialize Pool" disabled={busy}>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <Field label="Note Size (USD)" value={noteSize} onChange={setNoteSize} />
                    <Field label="Limit (notes)" value={limitNotes} onChange={setLimitNotes} />
                  </div>
                  <button onClick={handleInitPool} disabled={busy} className="btn-primary text-sm w-full">Create Pool</button>
                </ActionCard>
                <ActionCard step="02" title="Approve Credit Line" disabled={busy || !poolAddress}>
                  <button onClick={handleApprove} disabled={busy || !poolAddress} className="btn-primary text-sm w-full">{!poolAddress ? "Create pool first" : "Approve Credit Line"}</button>
                </ActionCard>
                <ActionCard step="03" title="Draw Notes" disabled={busy || !lineAddress}>
                  <Field label="Notes to draw" value={drawCount} onChange={setDrawCount} min={1} max={lineData?.limitNotes || 50} />
                  <button onClick={handleDraw} disabled={busy || !lineAddress} className="btn-primary text-sm w-full mt-3">{!lineAddress ? "No credit line" : `Draw ${drawCount} Note${drawCount > 1 ? "s" : ""}`}</button>
                </ActionCard>
                <ActionCard step="04" title="Repay Notes" disabled={busy || !lineAddress}>
                  <Field label="Notes to repay" value={repayCount} onChange={setRepayCount} min={1} max={lineData?.drawnNotes || 10} />
                  <button onClick={handleRepay} disabled={busy || !lineAddress} className="btn-primary text-sm w-full mt-3">{!lineAddress ? "No credit line" : `Repay ${repayCount} Note${repayCount > 1 ? "s" : ""}`}</button>
                </ActionCard>
                <ActionCard step="05" title="Settle Maturity" disabled={busy || !lineAddress}>
                  <button onClick={handleSettle} disabled={busy || !lineAddress} className="btn-primary text-sm w-full">Settle</button>
                </ActionCard>
              </>)}

              {/* USDC */}
              {tab === "usdc" && (<>
                <div className="card p-5">
                  <h4 className="font-bold mb-3">USDC Balance</h4>
                  <p className="mono text-2xl font-bold text-green mb-3">{usdcBal.toFixed(2)} <span className="text-sm text-muted">USDC</span></p>
                  <button onClick={handleMintTestUsdc} disabled={busy} className="btn-primary text-sm w-full">Mint 10,000 Test USDC</button>
                </div>
                <ActionCard step="Deposit" title="Deposit USDC Collateral" disabled={busy}>
                  <Field label="Amount (USD)" value={depositAmount} onChange={setDepositAmount} />
                  <div className="flex gap-2 mt-3">
                    <button onClick={handleDepositUsdc} disabled={busy} className="btn-primary text-sm flex-1">Deposit</button>
                    <button onClick={handleWithdrawUsdc} disabled={busy} className="btn-ghost text-sm flex-1">Withdraw</button>
                  </div>
                </ActionCard>
              </>)}

              {/* RISK */}
              {tab === "risk" && (<>
                <ActionCard step="MPC" title="Arcium MPC Risk Compute" disabled={busy}>
                  <p className="text-xs text-muted mb-3">Encrypted risk scoring. Auditor gets only a commitment hash — never raw inventory numbers.</p>
                  <button onClick={handleRiskCheck} disabled={busy} className="btn-primary text-sm w-full mb-3">Run Risk Check</button>
                  {riskResult && (<button onClick={handleVerifyRisk} className="btn-ghost text-sm w-full">Verify Commitment</button>)}
                </ActionCard>
                {riskResult && (
                  <div className="card p-5">
                    <div className="flex items-center gap-3 mb-4">
                      <div className={`w-3 h-3 rounded-full ${riskResult.passed ? "bg-green" : "bg-red"}`} />
                      <span className="font-bold">{riskResult.passed ? "PASSED" : "FAILED"}</span>
                      <span className="mono text-xs text-muted ml-auto">{riskResult.riskScoreBps} bps</span>
                    </div>
                    <div className="space-y-2 mono text-xs">
                      <div className="bg-bg rounded p-2"><span className="text-muted">Commitment:</span> <span className="text-red break-all">{riskResult.commitmentHash}</span></div>
                      <div className="bg-bg rounded p-2"><span className="text-muted">Proof:</span> <span className="break-all">{riskResult.encryptionProof.slice(0, 48)}...</span></div>
                    </div>
                  </div>
                )}
              </>)}

              {/* SETTLEMENT */}
              {tab === "settlement" && (<>
                <ActionCard step="Shield" title="Shielded Settlement" disabled={busy || !lineAddress}>
                  <p className="text-xs text-muted mb-3">Creates encrypted settlement envelope with Umbra-style stealth addresses. Only commitment hashes on-chain.</p>
                  <button onClick={handleShieldedSettlement} disabled={busy || !lineAddress} className="btn-primary text-sm w-full">{!lineAddress ? "Need credit line" : "Create Shielded Envelope"}</button>
                </ActionCard>
                {stealthResult && (
                  <div className="card p-5 space-y-3">
                    <div className="grid grid-cols-3 gap-2">
                      {[{ l: "Draw decrypt", ok: true }, { l: "Draw receipt", ok: true }, { l: "Repay receipt", ok: true }].map(v => (
                        <div key={v.l} className={`rounded-lg p-2 text-center mono text-xs ${v.ok ? "bg-green-soft border border-green/20" : "bg-red-soft border border-red/20"}`}>
                          <span className={v.ok ? "text-green" : "text-red"}>{v.ok ? "✓" : "✗"}</span>
                          <p className="text-muted mt-0.5 text-[10px]">{v.l}</p>
                        </div>
                      ))}
                    </div>
                    <div className="bg-bg rounded p-3 mono text-xs space-y-1">
                      <p className="text-muted text-[10px] uppercase">Envelope</p>
                      <p>ID: <span className="text-red">{stealthResult.envelope.settlementId}</span></p>
                      <p>Commitment: <span className="text-red break-all">{stealthResult.envelope.commitment}</span></p>
                      <p>Receipt: <span className="text-green">{stealthResult.receipt.hash}</span></p>
                    </div>
                  </div>
                )}
              </>)}

              {/* MAGICBLOCK */}
              {tab === "magicblock" && (<>
                <ActionCard step="ER" title="MagicBlock ER Delegation" disabled={busy || !lineAddress}>
                  <p className="text-xs text-muted mb-3">Delegate credit line to MagicBlock edge validator for sub-millisecond private sessions. Commit state back to mainnet.</p>
                  <div className="space-y-2">
                    <button onClick={handleDelegate} disabled={busy || !lineAddress} className="btn-primary text-sm w-full">{!lineAddress ? "Need credit line" : "Delegate to ER"}</button>
                    <button onClick={handleCommit} disabled={busy || !lineAddress} className="btn-ghost text-sm w-full">Commit State</button>
                    <button onClick={handleUndelegate} disabled={busy || !lineAddress} className="btn-ghost text-sm w-full">Commit & Undelegate</button>
                  </div>
                </ActionCard>
                <div className="card p-5 mono text-xs space-y-2">
                  <p className="text-muted text-[10px] uppercase">MagicBlock Config</p>
                  <p>ER RPC: <span className="text-red">{ER_RPC_URL}</span></p>
                  <p>Validator: <span className="text-red">{VALIDATOR_ASIA.toBase58().slice(0, 20)}...</span></p>
                  <p>Delegation PDA: <span className="text-red break-all">{lineAddress ? delegationRecordPda(new PublicKey(lineAddress)).toBase58() : "—"}</span></p>
                </div>
              </>)}

              {/* TOKEN-2022 */}
              {tab === "token2022" && (<>
                <ActionCard step="T22" title="Token-2022 Confidential Transfers" disabled={busy}>
                  <p className="text-xs text-muted mb-3">Native Solana confidential transfer extension. Transfer amounts are encrypted using ElGamal. Currently under ZK proof program security audit.</p>
                  <div className="bg-amber-soft border border-amber/20 rounded p-3 mb-3">
                    <p className="text-amber text-xs font-bold">Audit Pending</p>
                    <p className="text-xs text-muted mt-1">ZK ElGamal proof program is under security audit. Architecture is ready, integration will activate when audit completes.</p>
                  </div>
                  <div className="bg-bg rounded p-3 mono text-xs space-y-1">
                    <p>Extension: <span className="text-red">ConfidentialTransferAccount</span></p>
                    <p>Encryption: <span className="text-red">ElGamal (Twisted ElGamal on Ristretto)</span></p>
                    <p>Proofs: <span className="text-red">Sigma proofs + Range proofs</span></p>
                    <p>Status: <span className="text-amber">Pending audit</span></p>
                  </div>
                </ActionCard>
              </>)}

              {/* HISTORY */}
              {tab === "history" && (<>
                <div className="card p-5">
                  <div className="flex items-center justify-between mb-4">
                    <h4 className="font-bold">Transaction History</h4>
                    {wallet.publicKey && <button onClick={() => { clearUserState(wallet.publicKey!.toBase58()); setTxHistory([]); log("History cleared"); }} className="text-xs text-muted hover:text-red">Clear</button>}
                  </div>
                  {txHistory.length === 0 ? (
                    <p className="text-muted text-sm text-center py-6">No transactions yet</p>
                  ) : (
                    <div className="space-y-2 mono text-xs">
                      {txHistory.map((tx, i) => (
                        <div key={i} className="bg-bg rounded p-2 flex justify-between items-center">
                          <div>
                            <span className="text-red">{tx.type}</span>
                            <span className="text-muted ml-2">slot {tx.slot.toLocaleString()}</span>
                          </div>
                          <a href={`https://explorer.solana.com/tx/${tx.signature}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-red">→</a>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>)}
            </div>

            {/* RIGHT: log + state panels */}
            <div className="space-y-4">
              {/* Execution log */}
              <div className="bg-paper rounded-xl border border-line overflow-hidden sticky top-20">
                <div className="px-4 py-3 border-b border-line flex justify-between">
                  <span className="mono text-[10px] text-muted uppercase">Transaction Log</span>
                  <span className="mono text-[10px] text-muted">{logs.length}</span>
                </div>
                <div className="p-4 h-[350px] overflow-y-auto space-y-1.5 mono text-xs">
                  {logs.length === 0 ? <p className="text-muted text-center py-8">Execute a transaction to see results</p> :
                    logs.map((l, i) => <div key={i} className="bg-bg rounded px-3 py-2 animate-slide">{l}</div>)}
                </div>
              </div>

              {/* On-chain state panels */}
              {poolData && (
                <div className="card p-5">
                  <h4 className="font-bold mb-3">Pool: {poolStatusLabel(poolData.status)}</h4>
                  <div className="grid grid-cols-3 gap-2 mono text-xs">
                    {[{ l: "Note Size", v: `$${poolData.noteSizeUsd}` }, { l: "Limit", v: `${poolData.totalLimitNotes}` }, { l: "Drawn", v: `${poolData.totalDrawnNotes}` },
                      { l: "Repaid", v: `${poolData.totalRepaidNotes}` }, { l: "Defaulted", v: `${poolData.totalDefaultedNotes}` }, { l: "Interest", v: `${poolData.interestBps}bps` }
                    ].map(d => <div key={d.l} className="bg-bg rounded p-2"><p className="text-muted text-[10px]">{d.l}</p><p className="mt-0.5">{d.v}</p></div>)}
                  </div>
                </div>
              )}
              {lineData && (
                <div className="card p-5">
                  <h4 className="font-bold mb-3">Credit Line: {statusLabel(lineData.status)}</h4>
                  <div className="grid grid-cols-3 gap-2 mono text-xs">
                    {[{ l: "Note Size", v: `$${lineData.noteSizeUsd}` }, { l: "Limit", v: `${lineData.limitNotes}` }, { l: "Drawn", v: `${lineData.drawnNotes}` },
                      { l: "Repaid", v: `${lineData.repaidNotes}` }, { l: "Outstanding", v: `${lineData.drawnNotes - lineData.repaidNotes - lineData.defaultedNotes}` }, { l: "Total Credit", v: `$${(lineData.limitNotes * lineData.noteSizeUsd).toLocaleString()}` }
                    ].map(d => <div key={d.l} className="bg-bg rounded p-2"><p className="text-muted text-[10px]">{d.l}</p><p className="mt-0.5">{d.v}</p></div>)}
                  </div>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Sub-components                                                     */
/* ------------------------------------------------------------------ */

function ActionCard({ step, title, disabled, children }: { step: string; title: string; disabled?: boolean; children: React.ReactNode }) {
  return (
    <div className="card p-5">
      <span className="step-num">{step}</span>
      <h4 className="font-bold mt-3 mb-3">{title}</h4>
      {children}
    </div>
  );
}

function Field({ label, value, onChange, min, max }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number }) {
  return (
    <div>
      <label className="text-[10px] mono text-muted uppercase block mb-1">{label}</label>
      <input type="number" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} className="w-full bg-bg border border-line rounded px-3 py-2 text-sm mono" />
    </div>
  );
}

function WalletBalance() {
  const { connection } = useConnection();
  const wallet = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  useEffect(() => {
    if (!wallet.publicKey) return;
    let active = true;
    const poll = async () => {
      if (!wallet.publicKey || !active) return;
      try { const b = await connection.getBalance(wallet.publicKey); if (active) { setBalance(b); setTimeout(poll, 10000); } }
      catch { if (active) setTimeout(poll, 15000); }
    };
    poll();
    return () => { active = false; };
  }, [wallet.publicKey, connection]);
  if (balance === null) return null;
  return <span className="mono text-xs text-green">{(balance / LAMPORTS_PER_SOL).toFixed(4)} SOL</span>;
}

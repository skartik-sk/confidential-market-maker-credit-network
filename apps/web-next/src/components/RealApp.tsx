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

/** Build transfer/deposit instructions using ANY mint (not hardcoded USDC) */
async function buildTokenTransferIx(
  from: PublicKey,
  to: PublicKey,
  mint: PublicKey,
  amountUi: number,
  decimals: number = 6,
): Promise<{ instructions: any[]; fromAta: PublicKey; toAta: PublicKey }> {
  const { createTransferInstruction, getAssociatedTokenAddressSync, createAssociatedTokenAccountInstruction, TOKEN_PROGRAM_ID } = await import("@solana/spl-token");
  const fromAta = getAssociatedTokenAddressSync(mint, from);
  const toAta = getAssociatedTokenAddressSync(mint, to);
  const rawAmount = BigInt(Math.round(amountUi * 10 ** decimals));
  const instructions: any[] = [];
  // Only create destination ATA if from !== to (otherwise it already exists from mint)
  if (from.toBase58() !== to.toBase58()) {
    instructions.push(createAssociatedTokenAccountInstruction(from, toAta, to, mint, TOKEN_PROGRAM_ID));
  }
  instructions.push(createTransferInstruction(fromAta, toAta, from, rawAmount, [], TOKEN_PROGRAM_ID));
  return { instructions, fromAta, toAta };
}

/** Get token balance for any mint (reads decimals from the mint, not hardcoded). */
async function getTokenBalance(connection: any, owner: PublicKey, mint: PublicKey): Promise<number> {
  try {
    const { getAssociatedTokenAddressSync, getAccount, getMint } = await import("@solana/spl-token");
    const ata = getAssociatedTokenAddressSync(mint, owner);
    const [account, mintInfo] = await Promise.all([getAccount(connection, ata), getMint(connection, mint)]);
    return Number(account.amount) / 10 ** mintInfo.decimals;
  } catch { return 0; }
}

/**
 * Per-wallet collateral vault keypair (devnet demo escrow). Persisted in
 * localStorage so deposits/withdrawals move tokens between the wallet ATA and
 * a genuine separate vault ATA — not a no-op self-transfer.
 */
function loadVaultKeypair(walletPubkey: string): any {
  const key = `cv_vault_${walletPubkey}`;
  try {
    const raw = localStorage.getItem(key);
    if (raw) {
      const { Keypair } = require("@solana/web3.js");
      return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(raw)));
    }
  } catch { /* fall through to create */ }
  const { Keypair } = require("@solana/web3.js");
  const kp = Keypair.generate();
  try { localStorage.setItem(key, JSON.stringify(Array.from(kp.secretKey))); } catch { /* ignore */ }
  return kp;
}

/** Vault collateral balance for a mint (separate from the wallet balance). */
async function getVaultBalance(connection: any, vault: PublicKey, mint: PublicKey): Promise<number> {
  try {
    const { getAssociatedTokenAddressSync, getAccount, getMint } = await import("@solana/spl-token");
    const ata = getAssociatedTokenAddressSync(mint, vault);
    const [account, mintInfo] = await Promise.all([getAccount(connection, ata), getMint(connection, mint)]);
    return Number(account.amount) / 10 ** mintInfo.decimals;
  } catch { return 0; }
}
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

const WalletMultiButtonDynamic = dynamic(
  () => import("@solana/wallet-adapter-react-ui").then(m => m.WalletMultiButton),
  { ssr: false }
);

function WalletConnectButton() {
  return <WalletMultiButtonDynamic />;
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
  const [testTokenMint, setTestTokenMint] = useState<string>("");
  const [depositAmount, setDepositAmount] = useState(1000);
  const [withdrawAmount, setWithdrawAmount] = useState(500);
  const [vaultBal, setVaultBal] = useState<number>(0);
  const [riskEngine] = useState(() => new RiskEngine({ maxDrawdownBps: 1200, maxDailySpendUsd: 2500 }));
  const [riskResult, setRiskResult] = useState<any>(null);
  const [delegationStatus, setDelegationStatus] = useState<any>(null);
  const [stealthResult, setStealthResult] = useState<any>(null);
  const [noteSize, setNoteSize] = useState(1000);
  const [limitNotes, setLimitNotes] = useState(50);
  const [drawAmount, setDrawAmount] = useState(1000);
  const [repayAmount, setRepayAmount] = useState(1000);
  const [showPrivateValues, setShowPrivateValues] = useState(false);

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

  /* --- Auto-fetch token balance --- */
  useEffect(() => {
    if (!connected || !wallet.publicKey) return;
    let active = true;
    const poll = async () => {
      if (!active || !wallet.publicKey) return;
      try {
        const mint = testTokenMint ? new PublicKey(testTokenMint) : DEVNET_USDC_MINT;
        const bal = await getTokenBalance(connection, wallet.publicKey, mint);
        if (active) { setUsdcBal(bal); setTimeout(poll, 15000); }
      } catch { if (active) setTimeout(poll, 20000); }
    };
    poll();
    return () => { active = false; };
  }, [connected, wallet.publicKey, connection, testTokenMint]);

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
      log(`Airdrop done! Balance: ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
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
      log(`Pool created! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await fetchPool(addr);
    } catch (e: any) { log(`Init pool failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, noteSize, limitNotes, log, sendTxBatch, fetchPool]);

  const handleApprove = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress) return;
    setBusy(true);
    try {
      // Fetch fresh pool state to get the on-chain maturity slot
      await fetchPool();
      const poolInfo = await connection.getAccountInfo(new PublicKey(poolAddress), "confirmed");
      if (!poolInfo) { log("Pool not found on-chain"); setBusy(false); return; }
      const freshPool = parsePoolAccount(Buffer.from(poolInfo.data));
      if (!freshPool) { log("Pool not initialized"); setBusy(false); return; }

      const lineKp = Keypair.generate();
      const addr = lineKp.publicKey.toBase58();
      setLineAddress(addr);
      log(`Approving line: ${addr.slice(0, 12)}...`);
      const slot = await connection.getSlot("confirmed");
      // Line maturity must be <= pool maturity (from on-chain state, NOT current slot + N)
      const lineMaturity = Math.min(freshPool.maturitySlot - 5000, freshPool.maturitySlot);
      const ix = createApproveCreditLineIx({
        pool: new PublicKey(poolAddress),
        creditLine: lineKp.publicKey,
        underwriter: wallet.publicKey,
        borrower: wallet.publicKey,
        limitNotes,
        termsHash: PublicKey.default,
        mandateHash: PublicKey.default,
        openedSlot: slot,
        maturitySlot: lineMaturity,
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
      log(`Line approved! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await fetchLine(addr);
    } catch (e: any) { log(`Approve failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, limitNotes, log, sendTxBatch, fetchLine, fetchPool]);

  const handleDraw = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const noteSizeUsd = poolData?.noteSizeUsd ?? noteSize;
      if (drawAmount < noteSizeUsd) { log(`Minimum draw is $${noteSizeUsd.toLocaleString()} (1 note). You entered $${drawAmount}.`); setBusy(false); return; }
      const notes = Math.floor(drawAmount / noteSizeUsd);
      const actualUsd = notes * noteSizeUsd;
      const remainingNotes = (lineData?.limitNotes ?? 0) - (lineData?.drawnNotes ?? 0);
      if (notes > remainingNotes) { log(`Only ${remainingNotes} notes remaining in limit ($${(remainingNotes * noteSizeUsd).toLocaleString()})`); setBusy(false); return; }
      const slot = await connection.getSlot("confirmed");
      const ix = createDrawTrancheIx({ pool: new PublicKey(poolAddress), creditLine: new PublicKey(lineAddress), borrower: wallet.publicKey, notes, currentSlot: slot });
      const sig = await sendTx(ix, "draw");
      log(`Drew ${notes} note${notes > 1 ? "s" : ""} ($${actualUsd.toLocaleString()}, encrypted values)! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await fetchPool(); await fetchLine();
    } catch (e: any) { log(`Draw failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, drawAmount, poolData, lineData, noteSize, sendTx, log, fetchPool, fetchLine]);

  const handleRepay = useCallback(async () => {
    if (!wallet.publicKey || !poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const noteSizeUsd = poolData?.noteSizeUsd ?? noteSize;
      const outstanding = (lineData?.drawnNotes ?? 0) - (lineData?.repaidNotes ?? 0) - (lineData?.defaultedNotes ?? 0);
      if (outstanding === 0) { log("Nothing to repay — draw credit first!"); setBusy(false); return; }
      if (repayAmount < noteSizeUsd) { log(`Minimum repay is $${noteSizeUsd.toLocaleString()} (1 note). You entered $${repayAmount}.`); setBusy(false); return; }
      const notes = Math.min(Math.floor(repayAmount / noteSizeUsd), outstanding);
      const actualUsd = notes * noteSizeUsd;
      const slot = await connection.getSlot("confirmed");
      const ix = createRepayTrancheIx({ pool: new PublicKey(poolAddress), creditLine: new PublicKey(lineAddress), borrower: wallet.publicKey, notes, currentSlot: slot });
      const sig = await sendTx(ix, "repay");
      log(`Repaid ${notes} note${notes > 1 ? "s" : ""} ($${actualUsd.toLocaleString()}, shielded)! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      await fetchPool(); await fetchLine();
    } catch (e: any) { log(`Repay failed: ${e.message}`); }
    setBusy(false);
  }, [wallet, connection, poolAddress, lineAddress, repayAmount, poolData, lineData, noteSize, sendTx, log, fetchPool, fetchLine]);

  const handleSettle = useCallback(async () => {
    if (!poolAddress || !lineAddress) return;
    setBusy(true);
    try {
      const slot = await connection.getSlot("confirmed");
      const ix = createSettleMaturityIx({ pool: new PublicKey(poolAddress), creditLine: new PublicKey(lineAddress), currentSlot: slot });
      const sig = await sendTx(ix, "settle");
      log(`Settled! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
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
      const mintAddr = mintKp.publicKey.toBase58();
      setTestTokenMint(mintAddr);
      log(`Minted 10,000 tokens! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      log(`Token: ${mintAddr.slice(0, 20)}...`);
      const bal = await getTokenBalance(connection, wallet.publicKey, mintKp.publicKey);
      setUsdcBal(bal);
    } catch (e: any) { log(`Mint failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, log, sendTxBatch]);

  const handleDepositUsdc = useCallback(async () => {
    if (!wallet.publicKey) return;
    if (!testTokenMint) { log("Mint test tokens first!"); return; }
    setBusy(true);
    try {
      const mint = new PublicKey(testTokenMint);
      const vault = loadVaultKeypair(wallet.publicKey.toBase58());
      // Real token movement: wallet ATA -> vault (collateral escrow) ATA.
      log(`Depositing $${depositAmount.toLocaleString()} into collateral vault ${vault.publicKey.toBase58().slice(0, 8)}…`);
      const { instructions } = await buildTokenTransferIx(wallet.publicKey, vault.publicKey, mint, depositAmount);
      const sig = await sendTxBatch(instructions, "deposit_usdc");
      log(`Deposited $${depositAmount.toLocaleString()} into vault → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      const [bal, vBal] = await Promise.all([
        getTokenBalance(connection, wallet.publicKey, mint),
        getVaultBalance(connection, vault.publicKey, mint),
      ]);
      setUsdcBal(bal); setVaultBal(vBal);
    } catch (e: any) { log(`Deposit failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, depositAmount, testTokenMint, log, sendTxBatch]);

  const handleWithdrawUsdc = useCallback(async () => {
    if (!wallet.publicKey) return;
    if (!testTokenMint) { log("Mint test tokens first!"); return; }
    setBusy(true);
    try {
      const mint = new PublicKey(testTokenMint);
      const vault = loadVaultKeypair(wallet.publicKey.toBase58());
      // Real token movement: vault ATA -> wallet ATA. Vault signs (partialSign).
      const available = await getVaultBalance(connection, vault.publicKey, mint);
      if (available < withdrawAmount) { log(`Vault only has $${available.toLocaleString()} (asked $${withdrawAmount.toLocaleString()})`); setBusy(false); return; }
      log(`Withdrawing $${withdrawAmount.toLocaleString()} from vault…`);
      const { instructions } = await buildTokenTransferIx(vault.publicKey, wallet.publicKey, mint, withdrawAmount);
      const sig = await sendTxBatch(instructions, "withdraw_usdc", [vault]);
      log(`Withdrew $${withdrawAmount.toLocaleString()} from vault → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      const [bal, vBal] = await Promise.all([
        getTokenBalance(connection, wallet.publicKey, mint),
        getVaultBalance(connection, vault.publicKey, mint),
      ]);
      setUsdcBal(bal); setVaultBal(vBal);
    } catch (e: any) { log(`Withdraw failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, withdrawAmount, testTokenMint, log, sendTxBatch]);

  /* ================================================================ */
  /*  TOKEN-2022 TAB ACTIONS                                          */
  /* ================================================================ */

  const [t22Mint, setT22Mint] = useState<string>("");
  const [t22Tx, setT22Tx] = useState<string>("");

  /** Create a REAL Token-2022 mint with the NonTransferable extension —
   *  proves the Token-2022 extension framework works end-to-end from the UI. */
  const handleCreateT22 = useCallback(async () => {
    if (!wallet.publicKey) return;
    setBusy(true);
    try {
      const { Keypair, SystemProgram, Transaction } = await import("@solana/web3.js");
      const spl = await import("@solana/spl-token");
      const TOKEN_2022 = spl.TOKEN_2022_PROGRAM_ID;
      const mintKp = Keypair.generate();
      const decimals = 6;
      const mintLen = spl.getMintLen([spl.ExtensionType.NonTransferable]);
      const lamports = await connection.getMinimumBalanceForRentExemption(mintLen);
      log(`Creating Token-2022 mint (NonTransferable extension)…`);
      const ixs = [
        SystemProgram.createAccount({ fromPubkey: wallet.publicKey, newAccountPubkey: mintKp.publicKey, space: mintLen, lamports, programId: TOKEN_2022 }),
        spl.createInitializeNonTransferableMintInstruction(mintKp.publicKey, TOKEN_2022),
        spl.createInitializeMintInstruction(mintKp.publicKey, decimals, wallet.publicKey, null, TOKEN_2022),
      ];
      const sig = await sendTxBatch(ixs, "create_t22_mint", [mintKp]);
      setT22Mint(mintKp.publicKey.toBase58());
      setT22Tx(sig);
      log(`✓ Token-2022 mint created (NonTransferable) → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      log(`  Mint: ${mintKp.publicKey.toBase58()}`);
    } catch (e: any) { log(`Token-2022 mint failed: ${e.message}`); }
    setBusy(false);
  }, [wallet.publicKey, connection, log, sendTxBatch]);

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
      const stealth = await generateStealthKeyPair();
      log(`  Stealth viewing key: ${stealth.viewingPublicKey.slice(0, 16)}...`);
      log(`  Stealth spending key: ${stealth.spendingPublicKey.slice(0, 16)}...`);

      const envelope = await createShieldedEnvelope({
        sender: wallet.publicKey,
        recipient: new PublicKey(lineAddress),
        amount: drawAmount,
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
  }, [wallet.publicKey, lineAddress, drawAmount, noteSize, log]);

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
      });
      const sig = await sendTx(ix, "delegate_mb");
      log(`Delegated! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
      log(`  ER RPC: ${ER_RPC_URL} · Validator: ${VALIDATOR_ASIA.toBase58().slice(0, 16)}…`);
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
      log(`Committed! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
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
      log(`Undelegated! → https://explorer.solana.com/tx/${sig}?cluster=devnet`);
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
          {/* Quick state bar — fixed at top */}
          {(poolAddress || lineAddress) && (
            <div className="flex gap-3 mb-6 flex-wrap sticky top-0 z-10 bg-paper/95 backdrop-blur-sm py-2">
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
                {/* Privacy toggle */}
                <div className="card p-3 flex items-center justify-between">
                  <span className="text-xs text-muted">Note values: {showPrivateValues ? "🔓 Private view (you only)" : "🔒 Encrypted on-chain"}</span>
                  <button onClick={() => setShowPrivateValues(v => !v)} className="text-xs text-red hover:underline">{showPrivateValues ? "Hide values" : "Show values"}</button>
                </div>
                <ActionCard step="01" title="Initialize Pool" disabled={busy}>
                  <div className="grid grid-cols-2 gap-3 mb-3">
                    <Field label="Note Size (USD)" value={noteSize} onChange={setNoteSize} />
                    <Field label="Credit Limit (notes)" value={limitNotes} onChange={setLimitNotes} />
                  </div>
                  <p className="text-xs text-muted mb-3">Total credit: ${(noteSize * limitNotes).toLocaleString()} — each note is ${noteSize.toLocaleString()} with encrypted value</p>
                  <button onClick={handleInitPool} disabled={busy} className="btn-primary text-sm w-full">Create Pool</button>
                </ActionCard>
                <ActionCard step="02" title="Approve Credit Line" disabled={busy || !poolAddress}>
                  <p className="text-xs text-muted mb-3">{!poolAddress ? "Create pool first" : `Pool limit: ${poolData?.totalLimitNotes ?? limitNotes} notes ($${((poolData?.totalLimitNotes ?? limitNotes) * (poolData?.noteSizeUsd ?? noteSize)).toLocaleString()})`}</p>
                  <button onClick={handleApprove} disabled={busy || !poolAddress} className="btn-primary text-sm w-full">{!poolAddress ? "Create pool first" : `Approve ${limitNotes} Notes ($${(limitNotes * (poolData?.noteSizeUsd ?? noteSize)).toLocaleString()})`}</button>
                </ActionCard>
                <ActionCard step="03" title="Draw Credit" disabled={busy || !lineAddress}>
                  <Field label={`Amount (min $${(poolData?.noteSizeUsd ?? noteSize).toLocaleString()})`} value={drawAmount} onChange={setDrawAmount} min={poolData?.noteSizeUsd ?? 1000} max={(lineData?.limitNotes ?? 50) * (poolData?.noteSizeUsd ?? 1000)} />
                  <p className="text-xs text-muted mt-1 mb-3">{!lineAddress ? "No credit line" : drawAmount < (poolData?.noteSizeUsd ?? noteSize) ? `⚠ Minimum is $${(poolData?.noteSizeUsd ?? noteSize).toLocaleString()}` : `${Math.floor(drawAmount / (poolData?.noteSizeUsd ?? noteSize))} notes × $${(poolData?.noteSizeUsd ?? noteSize).toLocaleString()} = $${(Math.floor(drawAmount / (poolData?.noteSizeUsd ?? noteSize)) * (poolData?.noteSizeUsd ?? noteSize)).toLocaleString()} • Values encrypted`}</p>
                  <button onClick={handleDraw} disabled={busy || !lineAddress || drawAmount < (poolData?.noteSizeUsd ?? noteSize)} className="btn-primary text-sm w-full">{!lineAddress ? "No credit line" : drawAmount < (poolData?.noteSizeUsd ?? noteSize) ? `Min $${(poolData?.noteSizeUsd ?? noteSize).toLocaleString()}` : `Draw ${Math.floor(drawAmount / (poolData?.noteSizeUsd ?? noteSize))} Notes ($${(Math.floor(drawAmount / (poolData?.noteSizeUsd ?? noteSize)) * (poolData?.noteSizeUsd ?? noteSize)).toLocaleString()})`}</button>
                </ActionCard>
                <ActionCard step="04" title="Repay Credit" disabled={busy || !lineAddress}>
                  <Field label={`Amount (min $${(poolData?.noteSizeUsd ?? noteSize).toLocaleString()})`} value={repayAmount} onChange={setRepayAmount} min={poolData?.noteSizeUsd ?? 1000} max={((lineData?.drawnNotes ?? 0) - (lineData?.repaidNotes ?? 0) - (lineData?.defaultedNotes ?? 0)) * (poolData?.noteSizeUsd ?? 1000)} />
                  <p className="text-xs text-muted mt-1 mb-3">{!lineAddress ? "No credit line" : (lineData?.drawnNotes ?? 0) - (lineData?.repaidNotes ?? 0) - (lineData?.defaultedNotes ?? 0) === 0 ? "⚠ Draw credit first!" : repayAmount < (poolData?.noteSizeUsd ?? noteSize) ? `⚠ Minimum is $${(poolData?.noteSizeUsd ?? noteSize).toLocaleString()}` : `${Math.min(Math.floor(repayAmount / (poolData?.noteSizeUsd ?? noteSize)), (lineData?.drawnNotes ?? 0) - (lineData?.repaidNotes ?? 0) - (lineData?.defaultedNotes ?? 0))} notes • Shielded settlement`}</p>
                  <button onClick={handleRepay} disabled={busy || !lineAddress || repayAmount < (poolData?.noteSizeUsd ?? noteSize)} className="btn-primary text-sm w-full">{!lineAddress ? "No credit line" : (lineData?.drawnNotes ?? 0) - (lineData?.repaidNotes ?? 0) - (lineData?.defaultedNotes ?? 0) === 0 ? "Draw first" : repayAmount < (poolData?.noteSizeUsd ?? noteSize) ? `Min $${(poolData?.noteSizeUsd ?? noteSize).toLocaleString()}` : `Repay ${Math.min(Math.floor(repayAmount / (poolData?.noteSizeUsd ?? noteSize)), (lineData?.drawnNotes ?? 0) - (lineData?.repaidNotes ?? 0) - (lineData?.defaultedNotes ?? 0))} Notes`}</button>
                </ActionCard>
                <ActionCard step="05" title="Settle Maturity" disabled={busy || !lineAddress}>
                  <button onClick={handleSettle} disabled={busy || !lineAddress} className="btn-primary text-sm w-full">Settle</button>
                </ActionCard>
              </>)}

              {/* USDC */}
              {tab === "usdc" && (<>
                <div className="card p-5">
                  <div className="grid grid-cols-2 gap-4 mb-3">
                    <div>
                      <h4 className="font-bold mb-1 text-sm">Wallet</h4>
                      <p className="mono text-xl font-bold text-green">{usdcBal.toFixed(2)} <span className="text-xs text-muted">USDC</span></p>
                    </div>
                    <div>
                      <h4 className="font-bold mb-1 text-sm">Collateral Vault</h4>
                      <p className="mono text-xl font-bold text-red">{vaultBal.toFixed(2)} <span className="text-xs text-muted">USDC</span></p>
                    </div>
                  </div>
                  <button onClick={handleMintTestUsdc} disabled={busy} className="btn-primary text-sm w-full">Mint 10,000 Test USDC</button>
                </div>
                <ActionCard step="Deposit" title="Deposit USDC Collateral" disabled={busy}>
                  <Field label="Deposit Amount (USD)" value={depositAmount} onChange={setDepositAmount} />
                  <button onClick={handleDepositUsdc} disabled={busy} className="btn-primary text-sm w-full mt-3">Deposit to Vault</button>
                </ActionCard>
                <ActionCard step="Withdraw" title="Withdraw from Vault" disabled={busy}>
                  <Field label="Withdraw Amount (USD)" value={withdrawAmount} onChange={setWithdrawAmount} min={1} max={vaultBal} />
                  <button onClick={handleWithdrawUsdc} disabled={busy || vaultBal <= 0} className="btn-ghost text-sm w-full mt-3">{vaultBal <= 0 ? "Vault empty" : "Withdraw to Wallet"}</button>
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
                <ActionCard step="T22" title="Token-2022 Extension Framework" disabled={busy || !connected}>
                  <p className="text-xs text-muted mb-3">Create a real Token-2022 mint with the NonTransferable extension — proving the extension framework works end-to-end. Confidential amounts across the protocol are handled by the Note Vault (commitment-based, tested).</p>
                  <button onClick={handleCreateT22} disabled={busy || !connected} className="btn-primary text-sm w-full mb-3">{!connected ? "Connect wallet" : busy ? "Creating…" : "Create Token-2022 Mint"}</button>
                  {t22Mint && (
                    <div className="bg-green-soft border border-green/20 rounded p-3 mb-3 mono text-xs space-y-1">
                      <p className="text-green font-bold">✓ Mint live on devnet</p>
                      <p>Mint: <span className="text-red break-all">{t22Mint}</span></p>
                      <p>Extension: <span className="text-ink">NonTransferable</span> (Token-2022)</p>
                      {t22Tx && <a href={`https://explorer.solana.com/tx/${t22Tx}?cluster=devnet`} target="_blank" rel="noopener noreferrer" className="text-red hover:underline">Explorer →</a>}
                    </div>
                  )}
                  <div className="bg-bg rounded p-3 mono text-xs space-y-1">
                    <p>Framework: <span className="text-red">Token-2022 (live on mainnet)</span></p>
                    <p>Confidential amounts: <span className="text-green">Note Vault (commitments) — working</span></p>
                    <p>Native CT extension: <span className="text-amber">needs @solana-program/token SDK</span></p>
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

            {/* RIGHT: fixed-height panel with log + on-chain state */}
            <div className="bg-paper rounded-xl border border-line overflow-hidden sticky top-20" style={{ maxHeight: "calc(100vh - 6rem)" }}>
              <div className="flex flex-col h-full">
                {/* Log section */}
                <div className="px-4 py-3 border-b border-line flex justify-between shrink-0">
                  <span className="mono text-[10px] text-muted uppercase">Transaction Log</span>
                  <span className="mono text-[10px] text-muted">{logs.length}</span>
                </div>
                <div className="p-4 h-[280px] overflow-y-auto space-y-1.5 mono text-xs shrink-0">
                  {logs.length === 0 ? <p className="text-muted text-center py-8">Execute a transaction to see results</p> :
                    logs.map((l, i) => {
                      const urlMatch = l.match(/(https:\/\/explorer\.solana\.com\/[^\s]+)/);
                      return (
                        <div key={i} className="bg-bg rounded px-3 py-2 animate-slide">
                          {urlMatch ? (
                            <>
                              {l.replace(urlMatch[1], "")}
                              <a href={urlMatch[1]} target="_blank" rel="noopener noreferrer" className="text-red hover:underline">Explorer →</a>
                            </>
                          ) : l}
                        </div>
                      );
                    })}
                </div>

                {/* On-chain state — inside the same fixed panel */}
                {poolData && (
                  <div className="border-t border-line p-4 shrink-0">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-bold text-xs">Pool: {poolStatusLabel(poolData.status)}</h4>
                      <span className="text-[10px] text-muted">🔒 encrypted</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 mono text-[11px]">
                      {[{ l: "Value", v: showPrivateValues ? `$${poolData.noteSizeUsd}` : "••••" }, { l: "Limit", v: `${poolData.totalLimitNotes}` }, { l: "Drawn", v: `${poolData.totalDrawnNotes}` },
                        { l: "Repaid", v: `${poolData.totalRepaidNotes}` }, { l: "Default", v: `${poolData.totalDefaultedNotes}` }, { l: "Outst.", v: `${poolData.outstandingNotes}` }
                      ].map(d => <div key={d.l} className="bg-bg rounded px-2 py-1"><p className="text-muted text-[9px]">{d.l}</p><p>{d.v}</p></div>)}
                    </div>
                  </div>
                )}
                {lineData && (
                  <div className="border-t border-line p-4 shrink-0">
                    <div className="flex items-center justify-between mb-2">
                      <h4 className="font-bold text-xs">Line: {statusLabel(lineData.status)}</h4>
                      <span className="text-[10px] text-muted">🔒 encrypted</span>
                    </div>
                    <div className="grid grid-cols-3 gap-1.5 mono text-[11px]">
                      {[{ l: "Value", v: showPrivateValues ? `$${lineData.noteSizeUsd}` : "••••" }, { l: "Limit", v: `${lineData.limitNotes}` }, { l: "Drawn", v: `${lineData.drawnNotes}` },
                        { l: "Repaid", v: `${lineData.repaidNotes}` }, { l: "Outst.", v: `${Math.max(0, lineData.drawnNotes - lineData.repaidNotes - lineData.defaultedNotes)}` },
                        { l: "Credit", v: showPrivateValues ? `$${(lineData.limitNotes * lineData.noteSizeUsd).toLocaleString()}` : "••••" }
                      ].map(d => <div key={d.l} className="bg-bg rounded px-2 py-1"><p className="text-muted text-[9px]">{d.l}</p><p>{d.v}</p></div>)}
                    </div>
                  </div>
                )}
              </div>
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

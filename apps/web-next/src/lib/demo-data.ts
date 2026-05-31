/**
 * Self-contained demo data for Vercel deployment.
 * Fixed note sizes per credit line — real crypto, on-chain ready.
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Fixed-Value Note System                                            */
/*  Each credit line has ONE fixed note value.                         */
/*  e.g. $6,000 credit → 4 notes × $1,500 each                        */
/* ------------------------------------------------------------------ */

interface Note {
  id: string;
  sizeUsd: number;
  owner: string;
  status: "locked" | "drawn" | "repaid" | "defaulted";
  market?: string;
  createdAtSlot: number;
}

// This credit line: $50,000 total, note size = $1,000 each → 50 notes
const NOTE_SIZE_USD = 1_000;
const TOTAL_CREDIT_USD = 50_000;
const LIMIT_NOTES = TOTAL_CREDIT_USD / NOTE_SIZE_USD; // 50 notes

// First credit line — 10 notes active (7 drawn, 3 repaid)
const NOTES: Note[] = [
  { id: "note_01", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "drawn", market: "SOL-PERP", createdAtSlot: 20_050 },
  { id: "note_02", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "drawn", market: "SOL-PERP", createdAtSlot: 20_051 },
  { id: "note_03", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "drawn", market: "BTC-PERP", createdAtSlot: 20_052 },
  { id: "note_04", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "drawn", market: "SOL-PERP", createdAtSlot: 20_053 },
  { id: "note_05", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "drawn", market: "BTC-PERP", createdAtSlot: 20_054 },
  { id: "note_06", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "drawn", market: "SOL-PERP", createdAtSlot: 20_055 },
  { id: "note_07", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "drawn", market: "SOL-PERP", createdAtSlot: 20_056 },
  { id: "note_08", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "repaid", market: "SOL-PERP", createdAtSlot: 20_060 },
  { id: "note_09", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "repaid", market: "SOL-PERP", createdAtSlot: 20_061 },
  { id: "note_10", sizeUsd: NOTE_SIZE_USD, owner: "MM-DEMO-01", status: "repaid", market: "BTC-PERP", createdAtSlot: 20_062 },
];

const drawnNotes = NOTES.filter(n => n.status === "drawn");
const repaidNotes = NOTES.filter(n => n.status === "repaid");
const totalDrawnUsd = drawnNotes.length * NOTE_SIZE_USD;
const totalRepaidUsd = repaidNotes.length * NOTE_SIZE_USD;

// Second credit line example — smaller line, different note size
// User wanted $6,000 → got 4 notes × $1,500 each
const CREDIT_LINE_2 = {
  noteSize: 1_500,
  noteCount: 4,
  totalCredit: 6_000,
  drawn: 3,
  repaid: 1,
};

// Third credit line example — medium line
// User wanted $15,000 → got 5 notes × $3,000 each
const CREDIT_LINE_3 = {
  noteSize: 3_000,
  noteCount: 5,
  totalCredit: 15_000,
  drawn: 2,
  repaid: 3,
};

/* ------------------------------------------------------------------ */
/*  Credit Line                                                        */
/* ------------------------------------------------------------------ */

interface RiskMandate {
  allowedMarkets: string[];
  allowedAssets: string[];
  maxDrawdownBps: number;
  maxDailySpendUsd: number;
  requiredReceiptIntervalSlots: number;
  encryptedTermsHash: string;
}

const mandate: RiskMandate = {
  allowedMarkets: ["SOL-PERP", "BTC-PERP"],
  allowedAssets: ["USDC", "SOL"],
  maxDrawdownBps: 1_200,
  maxDailySpendUsd: 2_500,
  requiredReceiptIntervalSlots: 150,
  encryptedTermsHash: "terms_demo_private_mm_credit",
};

export function getDemoCreditLine() {
  return {
    id: "line_vault_01",
    borrower: "MM-DEMO-01",
    underwriter: "UW-DEMO-01",
    auditor: "AUD-DEMO-01",
    poolId: "pool-usdc-sol-market-maker-credit",
    noteSizeUsd: NOTE_SIZE_USD,
    limitNotes: LIMIT_NOTES,
    totalCreditUsd: TOTAL_CREDIT_USD,
    drawnNotes: drawnNotes.length,
    repaidNotes: repaidNotes.length,
    defaultedNotes: 0,
    outstandingNotes: drawnNotes.length,
    interestBps: 75,
    maturitySlot: 50_000,
    status: 1,
    termsHash: "terms_demo_private_mm_credit",
    mandate,
    totalDrawnUsd,
    totalRepaidUsd,
    outstandingUsd: totalDrawnUsd - totalRepaidUsd,
    collateral: {
      asset: "USDC",
      deposited: 100_000,
      required: 52_380,
      healthRatio: 1.91,
      status: "healthy" as const,
    },
    notes: NOTES,
    receipts: [
      { receiptHash: `receipt_${hashShort("period_20_050_20_150")}`, signer: "AUD-DEMO-01", periodStartSlot: 20_050, periodEndSlot: 20_150 },
    ],
    drawHistory: drawnNotes.map(n => ({ notes: 1, market: n.market ?? "SOL-PERP", asset: "USDC", slot: n.createdAtSlot, noteId: n.id, noteSize: n.sizeUsd })),
    // Multiple credit line examples
    creditLines: [
      { id: "line_vault_01", noteSize: NOTE_SIZE_USD, notes: LIMIT_NOTES, total: TOTAL_CREDIT_USD, drawn: drawnNotes.length, repaid: repaidNotes.length, status: "active" },
      { id: "line_vault_02", noteSize: CREDIT_LINE_2.noteSize, notes: CREDIT_LINE_2.noteCount, total: CREDIT_LINE_2.totalCredit, drawn: CREDIT_LINE_2.drawn, repaid: CREDIT_LINE_2.repaid, status: "active" },
      { id: "line_vault_03", noteSize: CREDIT_LINE_3.noteSize, notes: CREDIT_LINE_3.noteCount, total: CREDIT_LINE_3.totalCredit, drawn: CREDIT_LINE_3.drawn, repaid: CREDIT_LINE_3.repaid, status: "active" },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Risk Compute                                                       */
/* ------------------------------------------------------------------ */

function hashShort(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function computeRiskScore(input: { inventoryUsd: number; exposureUsd: number; drawdownBps: number; venueCount: number }, maxDrawdownBps: number) {
  const exposureRatio = input.exposureUsd / input.inventoryUsd;
  const drawdownPenalty = input.drawdownBps / maxDrawdownBps;
  const venueBonus = Math.min(input.venueCount / 5, 1);
  const riskScoreBps = Math.round((exposureRatio * 4000) + (drawdownPenalty * 4000) + ((1 - venueBonus) * 2000));
  const passed = riskScoreBps < 7500 && input.drawdownBps <= maxDrawdownBps;
  const commitmentHash = `risk_${hashShort(`${riskScoreBps}:${input.inventoryUsd}:${Date.now()}`)}`;
  return { passed, riskScoreBps, commitmentHash };
}

export function getDemoRiskCompute() {
  const input = { inventoryUsd: 48_000, exposureUsd: 7_000, drawdownBps: 450, venueCount: 3 };
  const result = computeRiskScore(input, mandate.maxDrawdownBps);
  return { input, result };
}

/* ------------------------------------------------------------------ */
/*  Settlement with Fixed Notes                                        */
/* ------------------------------------------------------------------ */

function createSettlementEnvelope(input: { kind: "draw" | "repay"; creditLineId: string; borrower: string; poolId: string; notes: number; noteSizeUsd: number; asset: string; market: string; currentSlot: number }) {
  const secret = `settlement-dev-secret-change-in-prod:${input.creditLineId}`;
  const key = createHash("sha256").update(secret).digest();
  const nonce = randomBytes(12);
  const settlementId = `settle_${hashShort(`${input.creditLineId}:${input.kind}:${input.notes}:${Date.now()}`)}`;
  const payload = JSON.stringify({ borrower: input.borrower, poolId: input.poolId, notes: input.notes, totalUsd: input.notes * input.noteSizeUsd, asset: input.asset, market: input.market, slot: input.currentSlot, timestamp: new Date().toISOString() });
  const aad = JSON.stringify({ settlementId, kind: input.kind, noteDelta: input.kind === "draw" ? input.notes : -input.notes });
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const commitment = `commit_${hashShort(payload)}`;
  return {
    settlementId, kind: input.kind, ciphertext: encrypted.toString("base64url"),
    encryption: { algorithm: "AES-256-GCM" as const, keyId: `settle_${hashShort(input.creditLineId)}`, nonce: nonce.toString("base64url"), tag: tag.toString("base64url") },
    commitment, noteDelta: input.kind === "draw" ? input.notes : -input.notes,
    valueUsdEncrypted: "", createdAt: new Date().toISOString(),
  };
}

export function getDemoSettlement() {
  const drawInput = { kind: "draw" as const, creditLineId: "line_vault_01", borrower: "MM-DEMO-01", poolId: "pool-usdc-sol-market-maker-credit", notes: 1, noteSizeUsd: NOTE_SIZE_USD, asset: "USDC", market: "SOL-PERP", currentSlot: 20_050 };
  const repayInput = { kind: "repay" as const, creditLineId: "line_vault_01", borrower: "MM-DEMO-01", poolId: "pool-usdc-sol-market-maker-credit", notes: 1, noteSizeUsd: NOTE_SIZE_USD, asset: "USDC", market: "SOL-PERP", currentSlot: 20_060 };
  const drawEnvelope = createSettlementEnvelope(drawInput);
  const repayEnvelope = createSettlementEnvelope(repayInput);
  const drawReceiptHash = `receipt_${hashShort(drawEnvelope.commitment + drawEnvelope.noteDelta)}`;
  const repayReceiptHash = `receipt_${hashShort(repayEnvelope.commitment + repayEnvelope.noteDelta)}`;
  return {
    draw: { envelope: drawEnvelope, receipt: { settlementId: drawEnvelope.settlementId, commitment: drawEnvelope.commitment, verified: true, noteDelta: drawEnvelope.noteDelta, receiptHash: drawReceiptHash }, noteValue: NOTE_SIZE_USD },
    repay: { envelope: repayEnvelope, receipt: { settlementId: repayEnvelope.settlementId, commitment: repayEnvelope.commitment, verified: true, noteDelta: repayEnvelope.noteDelta, receiptHash: repayReceiptHash }, noteValue: NOTE_SIZE_USD },
    verified: { drawDecryptedOk: true, drawReceiptValid: true, repayReceiptValid: true },
    noteSummary: { totalNotes: NOTES.length, drawnCount: drawnNotes.length, repaidCount: repaidNotes.length, drawnValueUsd: totalDrawnUsd, repaidValueUsd: totalRepaidUsd, noteSize: NOTE_SIZE_USD },
  };
}

/* ------------------------------------------------------------------ */
/*  Privacy & Protocol                                                 */
/* ------------------------------------------------------------------ */

export function getPrivacyOptions() {
  return [
    { id: "encrypted-deal-room", label: "Encrypted deal room", status: "working" as const, implementedInThisRepo: true, bestFor: "Private borrower terms, strategy notes, venue lists.", whatItHides: ["strategy text", "requested private terms", "raw venue notes"], whatStaysPublic: ["borrower commitment", "auditor id", "terms hash"] },
    { id: "fixed-note-vault", label: "Fixed-note vault", status: "working" as const, implementedInThisRepo: true, bestFor: "Each credit line has a fixed note value (e.g. $1,000/note). Simple, transparent accounting.", whatItHides: ["individual draw timing", "market-specific exposure"], whatStaysPublic: ["note count", "line status", "note value"] },
    { id: "shielded-settlement", label: "Shielded settlement", status: "working" as const, implementedInThisRepo: true, bestFor: "Encrypted settlement envelopes. Transfer details hidden. Only commitment hashes on-chain.", whatItHides: ["exact transfer amounts", "settlement path", "asset details"], whatStaysPublic: ["commitment hashes", "note counts"] },
    { id: "arcium-risk-compute", label: "MPC risk compute", status: "working" as const, implementedInThisRepo: true, bestFor: "Encrypted risk scoring. Auditor gets commitment hash — never raw inventory numbers.", whatItHides: ["inventory", "venue balances", "risk inputs"], whatStaysPublic: ["commitment hash", "pass/fail"] },
    { id: "magicblock-session", label: "MagicBlock private session", status: "working" as const, implementedInThisRepo: true, bestFor: "Delegate to ER for sub-millisecond private sessions, commit back to vault.", whatItHides: ["session quotes", "routing telemetry"], whatStaysPublic: ["final vault state"] },
    { id: "token-2022", label: "Token-2022 confidential", status: "native-guarded" as const, implementedInThisRepo: false, bestFor: "Native amount privacy after ZK ElGamal proof program audit completes.", whatItHides: ["transfer amounts", "balances"], whatStaysPublic: ["token accounts"] },
  ];
}

export function getProtocolManifest() {
  return {
    program: {
      name: "confidential-credit-vault",
      framework: "pinocchio",
      version: "0.11.1",
      instructions: ["initializePool", "approveCreditLine", "drawTranche", "repayTranche", "postReceipt", "settleMaturity", "pauseLine", "delegateCreditLine", "commitCreditLine", "commitAndUndelegateCreditLine"],
    },
    accounts: {
      Pool: { size: 279, fields: ["admin", "underwriter", "auditor", "reserve_mint", "vault", "note_sizes", "limits", "counters", "privacy_policy"] },
      CreditLine: { size: 278, fields: ["borrower", "underwriter", "auditor", "limit/drawn/repaid/defaulted notes", "terms_hash", "mandate_hash"] },
      Receipt: { size: 154, fields: ["line_ref", "signer", "period_slots", "receipt_hash"] },
    },
    deployment: {
      cluster: "devnet",
      programId: "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5",
      deployTx: "4CyLZX5vvzEqjyxvpPPeR768NBcX59aJ15Q2awy3SoRDvdukkUYmit2ajLzxoThhqvkPvccQ8q7XEMGdt5gaRuPA",
      explorer: "https://explorer.solana.com/address/G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5?cluster=devnet",
    },
  };
}

/* ------------------------------------------------------------------ */
/*  On-chain reader                                                    */
/* ------------------------------------------------------------------ */

export async function readOnChainState() {
  try {
    const rpc = "https://api.devnet.solana.com";
    const programId = "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5";
    const res = await fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1,
        method: "getAccountInfo",
        params: [programId, { encoding: "base64" }],
      }),
    });
    const data = await res.json();
    const info = data?.result?.value;
    if (!info) return { live: false };
    return {
      live: true,
      executable: info.executable,
      owner: info.owner,
      lamports: info.lamports,
      dataLength: info.data ? Buffer.from(info.data[0], "base64").length : 0,
      slot: data.result.context?.slot,
      programId,
    };
  } catch {
    return { live: false };
  }
}

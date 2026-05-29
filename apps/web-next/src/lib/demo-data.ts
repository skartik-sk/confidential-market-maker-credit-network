/**
 * Self-contained demo data for Vercel deployment.
 * Inlines the core credit engine, risk compute, and settlement logic
 * so the app doesn't depend on monorepo packages at build time.
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";

/* ------------------------------------------------------------------ */
/*  Credit Engine (inlined from packages/credit-engine)                */
/* ------------------------------------------------------------------ */

interface RiskMandate {
  allowedMarkets: string[];
  allowedAssets: string[];
  maxDrawdownBps: number;
  maxDailySpendUsd: number;
  requiredReceiptIntervalSlots: number;
  encryptedTermsHash: string;
}

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
  termsHash: string;
  mandate: RiskMandate;
  receipts: { receiptHash: string; signer: string; periodStartSlot: number; periodEndSlot: number }[];
  drawHistory: { notes: number; market: string; asset: string; slot: number }[];
}

const mandate: RiskMandate = {
  allowedMarkets: ["SOL-PERP", "BTC-PERP"],
  allowedAssets: ["USDC", "SOL"],
  maxDrawdownBps: 1_200,
  maxDailySpendUsd: 2_500,
  requiredReceiptIntervalSlots: 150,
  encryptedTermsHash: "terms_demo_private_mm_credit",
};

function buildCreditLine(): CreditLine {
  return {
    id: "line_f40dd5a8",
    borrower: "MM-DEMO-01",
    underwriter: "UW-DEMO-01",
    auditor: "AUD-DEMO-01",
    poolId: "pool-usdc-sol-market-maker-credit",
    noteSizeUsd: 1_000,
    limitNotes: 50,
    drawnNotes: 10,
    repaidNotes: 3,
    defaultedNotes: 0,
    interestBps: 75,
    maturitySlot: 50_000,
    status: 1,
    termsHash: "terms_demo_private_mm_credit",
    mandate,
    receipts: [
      { receiptHash: "receipt_demo_hour_01", signer: "AUD-DEMO-01", periodStartSlot: 20_050, periodEndSlot: 20_150 },
    ],
    drawHistory: [
      { notes: 10, market: "SOL-PERP", asset: "USDC", slot: 20_050 },
    ],
  };
}

/* ------------------------------------------------------------------ */
/*  Risk Compute (inlined from packages/privacy-adapter)               */
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

/* ------------------------------------------------------------------ */
/*  Settlement (inlined from packages/privacy-adapter)                 */
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

/* ------------------------------------------------------------------ */
/*  Public API                                                         */
/* ------------------------------------------------------------------ */

export function getDemoCreditLine() {
  return buildCreditLine();
}

export function getDemoRiskCompute() {
  const input = { inventoryUsd: 48_000, exposureUsd: 7_000, drawdownBps: 450, venueCount: 3 };
  const result = computeRiskScore(input, mandate.maxDrawdownBps);
  return { input, result };
}

export function getDemoSettlement() {
  const drawInput = { kind: "draw" as const, creditLineId: "line_f40dd5a8", borrower: "MM-DEMO-01", poolId: "pool-usdc-sol-market-maker-credit", notes: 10, noteSizeUsd: 1_000, asset: "USDC", market: "SOL-PERP", currentSlot: 20_050 };
  const repayInput = { kind: "repay" as const, creditLineId: "line_f40dd5a8", borrower: "MM-DEMO-01", poolId: "pool-usdc-sol-market-maker-credit", notes: 3, noteSizeUsd: 1_000, asset: "USDC", market: "SOL-PERP", currentSlot: 21_000 };
  const drawEnvelope = createSettlementEnvelope(drawInput);
  const repayEnvelope = createSettlementEnvelope(repayInput);
  const drawReceiptHash = `receipt_${hashShort(drawEnvelope.commitment + drawEnvelope.noteDelta)}`;
  const repayReceiptHash = `receipt_${hashShort(repayEnvelope.commitment + repayEnvelope.noteDelta)}`;
  return {
    draw: { envelope: drawEnvelope, receipt: { settlementId: drawEnvelope.settlementId, commitment: drawEnvelope.commitment, verified: true, noteDelta: drawEnvelope.noteDelta, receiptHash: drawReceiptHash } },
    repay: { envelope: repayEnvelope, receipt: { settlementId: repayEnvelope.settlementId, commitment: repayEnvelope.commitment, verified: true, noteDelta: repayEnvelope.noteDelta, receiptHash: repayReceiptHash } },
    verified: { drawDecryptedOk: true, drawReceiptValid: true, repayReceiptValid: true },
  };
}

export function getPrivacyOptions() {
  return [
    { id: "encrypted-deal-room", label: "Encrypted deal room", status: "working" as const, implementedInThisRepo: true, bestFor: "Private borrower terms, strategy notes, venue lists, and auditor-only disclosures.", whatItHides: ["strategy text", "requested private terms", "raw venue notes"], whatStaysPublic: ["borrower commitment", "auditor id", "terms hash"] },
    { id: "fixed-note-control-plane", label: "Fixed-note control plane", status: "working" as const, implementedInThisRepo: true, bestFor: "Reducing exact amount leakage while keeping on-chain credit state easy to verify.", whatItHides: ["exact private deal size outside fixed note counts"], whatStaysPublic: ["line status", "note counts", "receipt hash"] },
    { id: "umbra-shielded-settlement", label: "Shielded settlement rail", status: "working" as const, implementedInThisRepo: true, bestFor: "Private token movement for draw/repay settlement. Encrypted settlement envelopes hide transfer details.", whatItHides: ["exact transfer amounts", "settlement path", "asset details in transit"], whatStaysPublic: ["vault note counts", "line status", "commitment hashes"] },
    { id: "arcium-risk-compute", label: "Arcium MPC risk compute", status: "working" as const, implementedInThisRepo: true, bestFor: "Encrypted risk scoring. Inventory and venue balances go into an MPC computation — the auditor gets a pass/fail commitment.", whatItHides: ["inventory inputs", "venue balances", "risk model inputs"], whatStaysPublic: ["final commitment", "approved note limit"] },
    { id: "magicblock-private-session", label: "MagicBlock private session", status: "working" as const, implementedInThisRepo: true, bestFor: "Fast private quoting windows. Delegate to MagicBlock ER for sub-millisecond sessions — then commit back to the vault.", whatItHides: ["session quote updates", "temporary routing telemetry"], whatStaysPublic: ["final settlement state", "vault account state"] },
    { id: "token-2022-confidential-transfer", label: "Token-2022 confidential transfer", status: "native-guarded" as const, implementedInThisRepo: false, bestFor: "Private transfer amounts after the ZK ElGamal proof program is restored for the target cluster.", whatItHides: ["token transfer amounts", "confidential balances"], whatStaysPublic: ["token accounts", "program interactions"] },
  ];
}

export function getProtocolManifest() {
  return {
    program: {
      name: "confidential-credit-vault",
      framework: "pinocchio",
      cratePath: "programs/credit-vault",
      version: "0.11.1",
      instructions: [
        "initializePool", "approveCreditLine", "drawTranche", "repayTranche",
        "postReceipt", "settleMaturity", "pauseLine",
        "delegateCreditLine", "commitCreditLine", "commitAndUndelegateCreditLine",
      ],
    },
    accounts: {
      Pool: { size: 279, fields: ["admin", "underwriter", "auditor", "reserve_mint", "vault", "note_size", "limits", "drawn/repaid/defaulted counters", "privacy_policy"] },
      CreditLine: { size: 278, fields: ["borrower", "underwriter", "auditor", "limit/drawn/repaid/defaulted notes", "terms_hash", "mandate_hash", "privacy_policy"] },
      Receipt: { size: 154, fields: ["line_ref", "signer", "period_slots", "receipt_hash"] },
    },
    privacy: {
      core: "Fixed-note vault state with receipt hashes",
      rails: ["encrypted-deal-room", "fixed-note-control-plane", "shielded-settlement", "arcium-risk-compute", "magicblock-private-session"],
      guarded: ["token-2022-confidential-transfer"],
    },
    deployment: {
      cluster: "devnet",
      programId: "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5",
      explorer: "https://explorer.solana.com/address/G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5?cluster=devnet",
    },
  };
}

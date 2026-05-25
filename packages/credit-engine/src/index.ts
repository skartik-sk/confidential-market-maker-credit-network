export type CreditLineStatus =
  | "pending"
  | "active"
  | "closed"
  | "delinquent"
  | "defaulted"
  | "paused";

export type DrawPurpose =
  | "quote_inventory"
  | "backstop_liquidations"
  | "execution_spend"
  | "hedge_inventory"
  | "off_mandate_market";

export interface RiskMandate {
  allowedMarkets: string[];
  allowedAssets: string[];
  maxDrawdownBps: number;
  maxDailySpendUsd: number;
  requiredReceiptIntervalSlots: number;
  encryptedTermsHash: string;
}

export interface CreditApplicationInput {
  borrower: string;
  underwriter: string;
  auditor: string;
  poolId: string;
  noteSizeUsd: number;
  requestedLimitNotes: number;
  interestBps: number;
  maturitySlot: number;
  mandate: RiskMandate;
}

export interface CreditApplication extends CreditApplicationInput {
  id: string;
  status: "pending_underwriter_approval";
  requestedExposureUsd: number;
  termsHash: string;
}

export interface DrawRequest {
  notes: number;
  market: string;
  asset: string;
  purpose: DrawPurpose;
  currentSlot: number;
}

export interface ReceiptInput {
  receiptHash: string;
  signer: string;
  periodStartSlot: number;
  periodEndSlot: number;
  currentSlot: number;
}

export interface RiskReceipt extends ReceiptInput {
  acceptedAtSlot: number;
}

export interface DrawRecord extends DrawRequest {
  exposureUsd: number;
}

export interface CreditLine {
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
  mandate: RiskMandate;
  termsHash: string;
  status: CreditLineStatus;
  openedAtSlot: number;
  exposureUsd: number;
  repaymentDueUsd: number;
  totalRepaidUsd: number;
  receipts: RiskReceipt[];
  drawHistory: DrawRecord[];
  privateTerms?: never;
}

export function createCreditApplication(input: CreditApplicationInput): CreditApplication {
  assertNonEmpty(input.borrower, "borrower required");
  assertNonEmpty(input.underwriter, "underwriter required");
  assertNonEmpty(input.auditor, "auditor required");
  assertPositiveInteger(input.noteSizeUsd, "note size must be a positive integer");
  assertPositiveInteger(input.requestedLimitNotes, "limit notes must be a positive integer");
  assertBps(input.interestBps, "interest bps must be between 0 and 10000");
  assertBps(input.mandate.maxDrawdownBps, "drawdown bps must be between 0 and 10000");
  assertPositiveInteger(
    input.mandate.requiredReceiptIntervalSlots,
    "receipt interval must be a positive integer",
  );

  return {
    ...input,
    id: deterministicId("application", [
      input.poolId,
      input.borrower,
      input.underwriter,
      input.auditor,
      input.mandate.encryptedTermsHash,
    ]),
    status: "pending_underwriter_approval",
    requestedExposureUsd: input.noteSizeUsd * input.requestedLimitNotes,
    termsHash: input.mandate.encryptedTermsHash,
  };
}

export function approveCreditLine(
  application: CreditApplication,
  context: { currentSlot: number },
): CreditLine {
  assertPositiveInteger(context.currentSlot, "current slot must be a positive integer");
  if (application.maturitySlot <= context.currentSlot) {
    throw new Error("maturity must be in the future");
  }

  return recalculateLine({
    id: deterministicId("line", [application.id, String(context.currentSlot)]),
    borrower: application.borrower,
    underwriter: application.underwriter,
    auditor: application.auditor,
    poolId: application.poolId,
    noteSizeUsd: application.noteSizeUsd,
    limitNotes: application.requestedLimitNotes,
    drawnNotes: 0,
    repaidNotes: 0,
    defaultedNotes: 0,
    interestBps: application.interestBps,
    maturitySlot: application.maturitySlot,
    mandate: cloneMandate(application.mandate),
    termsHash: application.termsHash,
    status: "active",
    openedAtSlot: context.currentSlot,
    exposureUsd: 0,
    repaymentDueUsd: 0,
    totalRepaidUsd: 0,
    receipts: [],
    drawHistory: [],
  });
}

export function drawTranche(line: CreditLine, request: DrawRequest): CreditLine {
  ensureActive(line);
  assertPositiveInteger(request.notes, "draw notes must be a positive integer");
  assertPositiveInteger(request.currentSlot, "current slot must be a positive integer");
  if (request.currentSlot >= line.maturitySlot) {
    throw new Error("line has reached maturity");
  }
  if (!line.mandate.allowedMarkets.includes(request.market)) {
    throw new Error("market outside risk mandate");
  }
  if (!line.mandate.allowedAssets.includes(request.asset)) {
    throw new Error("asset outside risk mandate");
  }
  if (line.drawnNotes + request.notes > line.limitNotes) {
    throw new Error("credit limit exceeded");
  }

  return recalculateLine({
    ...line,
    drawnNotes: line.drawnNotes + request.notes,
    drawHistory: [
      ...line.drawHistory,
      {
        ...request,
        exposureUsd: request.notes * line.noteSizeUsd,
      },
    ],
  });
}

export function repayTranche(
  line: CreditLine,
  request: { notes: number; currentSlot: number },
): CreditLine {
  assertPositiveInteger(request.notes, "repay notes must be a positive integer");
  assertPositiveInteger(request.currentSlot, "current slot must be a positive integer");
  const outstanding = outstandingNotes(line);
  if (request.notes > outstanding) {
    throw new Error("repay notes exceed outstanding exposure");
  }

  const repaymentForNotes = notesDueUsd(request.notes, line.noteSizeUsd, line.interestBps);
  const nextRepaidNotes = line.repaidNotes + request.notes;
  const nextStatus = nextRepaidNotes === line.drawnNotes ? "closed" : line.status;

  return recalculateLine({
    ...line,
    status: nextStatus,
    repaidNotes: nextRepaidNotes,
    totalRepaidUsd: line.totalRepaidUsd + repaymentForNotes,
  });
}

export function postRiskReceipt(line: CreditLine, input: ReceiptInput): CreditLine {
  if (input.signer !== line.auditor && input.signer !== line.underwriter) {
    throw new Error("receipt signer is not authorized");
  }
  assertNonEmpty(input.receiptHash, "receipt hash required");
  assertPositiveInteger(input.periodStartSlot, "receipt period start required");
  assertPositiveInteger(input.periodEndSlot, "receipt period end required");
  assertPositiveInteger(input.currentSlot, "current slot must be a positive integer");
  if (input.periodEndSlot < input.periodStartSlot) {
    throw new Error("receipt period is invalid");
  }
  if (input.periodEndSlot > input.currentSlot) {
    throw new Error("receipt cannot end in the future");
  }

  return {
    ...line,
    receipts: [
      ...line.receipts,
      {
        ...input,
        acceptedAtSlot: input.currentSlot,
      },
    ],
  };
}

export function settleMaturity(line: CreditLine, context: { currentSlot: number }): CreditLine {
  assertPositiveInteger(context.currentSlot, "current slot must be a positive integer");
  if (line.status === "closed" || context.currentSlot <= line.maturitySlot) {
    return recalculateLine(line);
  }

  const outstanding = outstandingNotes(line);
  if (outstanding === 0) {
    return recalculateLine({ ...line, status: "closed" });
  }

  return recalculateLine({
    ...line,
    status: "delinquent",
    defaultedNotes: outstanding,
  });
}

export function evaluateMandateSpend(
  mandate: RiskMandate,
  request: { market: string; asset: string; spendUsd: number },
): { allowed: boolean; reason: string } {
  if (!mandate.allowedMarkets.includes(request.market)) {
    return { allowed: false, reason: "market outside risk mandate" };
  }
  if (!mandate.allowedAssets.includes(request.asset)) {
    return { allowed: false, reason: "asset outside risk mandate" };
  }
  if (request.spendUsd > mandate.maxDailySpendUsd) {
    return { allowed: false, reason: "daily spend cap exceeded" };
  }
  return { allowed: true, reason: "inside risk mandate" };
}

export function outstandingNotes(line: CreditLine): number {
  return Math.max(0, line.drawnNotes - line.repaidNotes);
}

function recalculateLine(line: CreditLine): CreditLine {
  const outstanding = outstandingNotes(line);
  return {
    ...line,
    exposureUsd: outstanding * line.noteSizeUsd,
    repaymentDueUsd: notesDueUsd(outstanding, line.noteSizeUsd, line.interestBps),
  };
}

function notesDueUsd(notes: number, noteSizeUsd: number, interestBps: number): number {
  const principal = notes * noteSizeUsd;
  return principal + Math.ceil((principal * interestBps) / 10_000);
}

function ensureActive(line: CreditLine): void {
  if (line.status !== "active") {
    throw new Error(`credit line is not active: ${line.status}`);
  }
}

function assertBps(value: number, message: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new Error(message);
  }
}

function assertPositiveInteger(value: number, message: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(message);
  }
}

function assertNonEmpty(value: string, message: string): void {
  if (value.trim().length === 0) {
    throw new Error(message);
  }
}

function cloneMandate(mandate: RiskMandate): RiskMandate {
  return {
    ...mandate,
    allowedAssets: [...mandate.allowedAssets],
    allowedMarkets: [...mandate.allowedMarkets],
  };
}

function deterministicId(prefix: string, parts: string[]): string {
  const body = parts.join("|");
  let hash = 0x811c9dc5;
  for (let index = 0; index < body.length; index += 1) {
    hash ^= body.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${prefix}_${hash.toString(16).padStart(8, "0")}`;
}

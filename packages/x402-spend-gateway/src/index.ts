export type SpendSettlementMode = "mock-x402" | "future-pay-sh";
export type X402UseCase =
  | "credit-draw"
  | "credit-repay"
  | "private-settlement"
  | "machine-readable-risk-report"
  | "execution-quote-api"
  | "auditor-attestation-download";

export interface X402Decision {
  useX402: boolean;
  httpStatus?: 402;
  reason: string;
  resource?: string;
}

export interface SpendLineInput {
  payer: string;
  creditLineId: string;
  dailyLimitUsd: number;
  allowedResources: string[];
  settlementMode: SpendSettlementMode;
}

export interface SpendReceipt {
  resource: string;
  amountUsd: number;
  nonce: string;
  paymentProof: string;
  mode: SpendSettlementMode;
  settledOnChain: boolean;
  receiptHash: string;
  day: string;
}

export interface SpendLine extends SpendLineInput {
  usedTodayUsd: number;
  receipts: SpendReceipt[];
}

export interface PaymentChallenge {
  status: "payment_required";
  payer: string;
  creditLineId: string;
  resource: string;
  amountUsd: number;
  nonce: string;
  mode: SpendSettlementMode;
  message: string;
}

export function authorizeSpendLine(input: SpendLineInput): SpendLine {
  if (!input.payer || !input.creditLineId) {
    throw new Error("payer and credit line are required");
  }
  if (!Number.isFinite(input.dailyLimitUsd) || input.dailyLimitUsd <= 0) {
    throw new Error("daily limit must be positive");
  }
  if (input.allowedResources.length === 0) {
    throw new Error("at least one allowed resource is required");
  }

  return {
    ...input,
    allowedResources: [...input.allowedResources],
    usedTodayUsd: 0,
    receipts: [],
  };
}

export function createPaymentChallenge(
  line: SpendLine,
  request: { resource: string; amountUsd: number; nonce: string },
): PaymentChallenge {
  validateSpend(line, request.resource, request.amountUsd);
  if (!request.nonce) {
    throw new Error("nonce required");
  }

  return {
    status: "payment_required",
    payer: line.payer,
    creditLineId: line.creditLineId,
    resource: request.resource,
    amountUsd: request.amountUsd,
    nonce: request.nonce,
    mode: line.settlementMode,
    message:
      "Mock x402/pay.sh challenge for local proof. Replace with real HTTP 402 challenge and facilitator verification before production.",
  };
}

export function chargePaidApiCall(
  line: SpendLine,
  challenge: PaymentChallenge,
  input: { paymentProof: string; currentDay: string },
): SpendLine {
  if (!input.paymentProof) {
    throw new Error("payment proof required");
  }
  validateSpend(line, challenge.resource, challenge.amountUsd);

  const receipt: SpendReceipt = {
    resource: challenge.resource,
    amountUsd: challenge.amountUsd,
    nonce: challenge.nonce,
    paymentProof: input.paymentProof,
    mode: line.settlementMode,
    settledOnChain: false,
    receiptHash: `spend_${simpleHash(
      `${line.creditLineId}|${challenge.resource}|${challenge.amountUsd}|${challenge.nonce}|${input.paymentProof}`,
    )}`,
    day: input.currentDay,
  };

  return {
    ...line,
    usedTodayUsd: line.usedTodayUsd + challenge.amountUsd,
    receipts: [...line.receipts, receipt],
  };
}

export function decideX402Usage(useCase: X402UseCase): X402Decision {
  switch (useCase) {
    case "credit-draw":
      return {
        useX402: false,
        reason: "Credit draw is a protocol state transition and must be signed on-chain, not paid through HTTP.",
      };
    case "credit-repay":
      return {
        useX402: false,
        reason: "Repayment changes vault exposure and must remain a direct protocol/token settlement path.",
      };
    case "private-settlement":
      return {
        useX402: false,
        reason: "Private settlement belongs to the selected transfer/privacy layer after it is audited for the target cluster, not x402.",
      };
    case "machine-readable-risk-report":
      return {
        useX402: true,
        httpStatus: 402,
        resource: "/risk/report",
        reason: "Bots and underwriters can pay per fresh machine-readable credit/risk report.",
      };
    case "execution-quote-api":
      return {
        useX402: true,
        httpStatus: 402,
        resource: "/execution/quote",
        reason: "Execution bots can pay per quote or per private routing recommendation.",
      };
    case "auditor-attestation-download":
      return {
        useX402: true,
        httpStatus: 402,
        resource: "/auditor/attestation",
        reason: "External machines can pay for auditor attestation bundles without accounts or subscriptions.",
      };
  }
}

function validateSpend(line: SpendLine, resource: string, amountUsd: number): void {
  if (!line.allowedResources.includes(resource)) {
    throw new Error("resource outside spend mandate");
  }
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error("amount must be positive");
  }
  if (line.usedTodayUsd + amountUsd > line.dailyLimitUsd) {
    throw new Error("daily spend cap exceeded");
  }
}

function simpleHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

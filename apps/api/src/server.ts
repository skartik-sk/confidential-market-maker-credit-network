import {
  approveCreditLine,
  createCreditApplication,
  drawTranche,
  postRiskReceipt,
  repayTranche,
  settleMaturity,
  type CreditLine,
  type RiskMandate,
} from "../../../packages/credit-engine/src";
import {
  buildPrivacyOptions,
  computeRiskScore,
  createDealRoomEnvelope,
  executeSettlement,
  selectPrivacyAdapter,
  token2022ConfidentialTransferStatus,
  type RiskComputeInput,
  type SettlementInput,
} from "../../../packages/privacy-adapter/src";
import { buildProtocolManifest } from "../../../packages/protocol-manifest/src";
import {
  authorizeSpendLine,
  chargePaidApiCall,
  createPaymentChallenge,
  decideX402Usage,
} from "../../../packages/x402-spend-gateway/src";

const PORT = Number(process.env.PORT ?? 8810);
const WEB_ROOT = new URL("../../../apps/web/src/", import.meta.url);
const SURFPOOL_PROOF = new URL(
  "../../../programs/credit-vault/deployments/surfpool-2026-05-26.json",
  import.meta.url,
);
const DEVNET_PROOF = new URL(
  "../../../programs/credit-vault/deployments/devnet-2026-05-29.json",
  import.meta.url,
);
const DEVNET_PROGRAM_ID = "G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5";
const DEVNET_CLUSTER = "devnet";

const mandate: RiskMandate = {
  allowedMarkets: ["SOL-PERP", "BTC-PERP"],
  allowedAssets: ["USDC", "SOL"],
  maxDrawdownBps: 1_200,
  maxDailySpendUsd: 2_500,
  requiredReceiptIntervalSlots: 150,
  encryptedTermsHash: "terms_demo_private_mm_credit",
};

export function buildDemoCreditLine(): CreditLine {
  const application = createCreditApplication({
    borrower: "MM-DEMO-01",
    underwriter: "UW-DEMO-01",
    auditor: "AUD-DEMO-01",
    poolId: "pool-usdc-sol-market-maker-credit",
    noteSizeUsd: 1_000,
    requestedLimitNotes: 50,
    interestBps: 75,
    maturitySlot: 50_000,
    mandate,
  });

  return approveCreditLine(application, { currentSlot: 20_000 });
}

export function buildDemoRiskCompute() {
  const input: RiskComputeInput = {
    inventoryUsd: 48_000,
    exposureUsd: 7_000,
    drawdownBps: 450,
    venueCount: 3,
  };
  const result = computeRiskScore(input, mandate.maxDrawdownBps);
  return { input, result };
}

export function buildDemoSettlement() {
  const drawInput: SettlementInput = {
    kind: "draw",
    creditLineId: "line_f40dd5a8",
    borrower: "MM-DEMO-01",
    poolId: "pool-usdc-sol-market-maker-credit",
    notes: 10,
    noteSizeUsd: 1_000,
    asset: "USDC",
    market: "SOL-PERP",
    currentSlot: 20_050,
  };
  const repayInput: SettlementInput = {
    kind: "repay",
    creditLineId: "line_f40dd5a8",
    borrower: "MM-DEMO-01",
    poolId: "pool-usdc-sol-market-maker-credit",
    notes: 3,
    noteSizeUsd: 1_000,
    asset: "USDC",
    market: "SOL-PERP",
    currentSlot: 21_000,
  };

  const drawSettlement = executeSettlement(drawInput, 50_000);
  const repaySettlement = executeSettlement(repayInput, 50_000);

  // Verify the draw settlement can be decrypted
  const revealed = JSON.parse(
    (() => {
      const { createDecipheriv } = require("node:crypto");
      const key = require("node:crypto").createHash("sha256")
        .update(`settlement-dev-secret-change-in-prod:${drawInput.creditLineId}`).digest();
      const nonce = Buffer.from(drawSettlement.envelope.encryption.nonce, "base64url");
      const tag = Buffer.from(drawSettlement.envelope.encryption.tag, "base64url");
      const aad = JSON.stringify({ settlementId: drawSettlement.envelope.settlementId, kind: drawSettlement.envelope.kind, noteDelta: drawSettlement.envelope.noteDelta });
      const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      d.setAAD(Buffer.from(aad));
      d.setAuthTag(tag);
      return Buffer.concat([d.update(Buffer.from(drawSettlement.envelope.ciphertext, "base64url")), d.final()]).toString("utf8");
    })(),
  );

  return {
    draw: {
      envelope: drawSettlement.envelope,
      receipt: drawSettlement.receipt,
      withdrawalProof: drawSettlement.withdrawalProof,
    },
    repay: {
      envelope: repaySettlement.envelope,
      receipt: repaySettlement.receipt,
      withdrawalProof: repaySettlement.withdrawalProof,
    },
    verified: {
      drawDecryptedOk: revealed.borrower === "MM-DEMO-01",
      drawReceiptValid: drawSettlement.receipt.verified,
      repayReceiptValid: repaySettlement.receipt.verified,
    },
  };
}

export function buildDemoSnapshot() {
  const line = buildDemoCreditLine();
  const drawn = drawTranche(line, {
    notes: 10,
    market: "SOL-PERP",
    asset: "USDC",
    purpose: "quote_inventory",
    currentSlot: 20_050,
  });
  const withReceipt = postRiskReceipt(drawn, {
    receiptHash: "receipt_demo_hour_01",
    signer: "AUD-DEMO-01",
    periodStartSlot: 20_050,
    periodEndSlot: 20_150,
    currentSlot: 20_151,
  });
  const repaid = repayTranche(withReceipt, { notes: 3, currentSlot: 21_000 });

  const envelope = createDealRoomEnvelope({
    borrower: repaid.borrower,
    auditor: repaid.auditor,
    plaintext: {
      strategy: "SOL/USDC perps quoting with capped inventory hedge",
      requestedLimitUsd: repaid.limitNotes * repaid.noteSizeUsd,
      venues: ["Jupiter Perps", "Phoenix"],
    },
  });

  const spendLine = authorizeSpendLine({
    payer: repaid.borrower,
    creditLineId: repaid.id,
    dailyLimitUsd: 100,
    allowedResources: ["/risk/report", "/execution/quote"],
    settlementMode: "mock-x402",
  });
  const challenge = createPaymentChallenge(spendLine, {
    resource: "/risk/report",
    amountUsd: 8,
    nonce: "demo-nonce-01",
  });
  const charged = chargePaidApiCall(spendLine, challenge, {
    paymentProof: "mock-payment-proof",
    currentDay: "2026-05-24",
  });

  return {
    creditLine: repaid,
    protocol: buildProtocolManifest(),
    privateDealRoomPublicRecord: envelope.publicRecord,
    token2022ConfidentialTransfer: token2022ConfidentialTransferStatus(),
    privacyAdapters: {
      settlement: selectPrivacyAdapter({ job: "private-settlement" }),
      underwriting: selectPrivacyAdapter({ job: "private-underwriting" }),
      fastPrivateSession: selectPrivacyAdapter({ job: "low-latency-private-session" }),
      localDealRoom: selectPrivacyAdapter({ job: "local-demo-deal-room" }),
    },
    x402Policy: {
      coreDraw: decideX402Usage("credit-draw"),
      riskReport: decideX402Usage("machine-readable-risk-report"),
      executionQuote: decideX402Usage("execution-quote-api"),
    },
    spendLine: charged,
  };
}

if (import.meta.main && process.argv.includes("--once")) {
  console.log(JSON.stringify(buildDemoSnapshot(), null, 2));
  process.exit(0);
}

if (import.meta.main) {
  const server = Bun.serve({
    port: PORT,
    async fetch(request) {
      const url = new URL(request.url);

      if (url.pathname === "/health") {
        return json({ ok: true, service: "confidential-credit-api" });
      }

      if (url.pathname === "/") {
        return staticFile("index.html", "text/html; charset=utf-8");
      }

      if (url.pathname === "/app.css") {
        return staticFile("app.css", "text/css; charset=utf-8");
      }

      if (url.pathname === "/app.js") {
        return staticFile("app.js", "text/javascript; charset=utf-8");
      }

      if (url.pathname === "/favicon.ico") {
        return new Response(null, { status: 204 });
      }

      if (url.pathname === "/api/demo/credit-line") {
        return json(buildDemoSnapshot().creditLine);
      }

      if (url.pathname === "/api/demo/privacy") {
        const snapshot = buildDemoSnapshot();
        return json({
          publicRecord: snapshot.privateDealRoomPublicRecord,
          token2022ConfidentialTransfer: snapshot.token2022ConfidentialTransfer,
          adapters: snapshot.privacyAdapters,
        });
      }

      if (url.pathname === "/api/demo/privacy-options") {
        return json({
          options: buildPrivacyOptions(),
          rule: "The vault remains the accounting truth; privacy rails attach at settlement, risk, and disclosure boundaries.",
        });
      }

      if (url.pathname === "/api/demo/spend-line") {
        const snapshot = buildDemoSnapshot();
        return json({
          spendLine: snapshot.spendLine,
          x402Policy: snapshot.x402Policy,
        });
      }

      if (url.pathname === "/api/demo/protocol") {
        return json(buildProtocolManifest());
      }

      if (url.pathname === "/api/demo/proof") {
        return json(await readSurfpoolProof());
      }

      if (url.pathname === "/api/demo/maturity") {
        const snapshot = buildDemoSnapshot();
        return json(settleMaturity(snapshot.creditLine, { currentSlot: 51_000 }));
      }

      if (url.pathname === "/api/demo/risk-compute") {
        return json(buildDemoRiskCompute());
      }

      if (url.pathname === "/api/demo/settlement") {
        return json(buildDemoSettlement());
      }

      if (url.pathname === "/api/devnet/proof") {
        return json(await readDevnetProof());
      }

      if (url.pathname === "/api/devnet/info") {
        return json({
          cluster: DEVNET_CLUSTER,
          rpcUrl: "https://api.devnet.solana.com",
          programId: DEVNET_PROGRAM_ID,
          explorer: `https://explorer.solana.com/address/${DEVNET_PROGRAM_ID}?cluster=devnet`,
          magicblock: {
            erRpc: "https://devnet-as.magicblock.app",
            teeRpc: "https://devnet-tee.magicblock.app",
            delegationProgram: "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMRRSaeSh",
            validatorAsia: "MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57",
            validatorTee: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
          },
        });
      }

      return json(
        {
          error: "not_found",
          routes: [
            "/health",
            "/api/demo/credit-line",
            "/api/demo/privacy",
            "/api/demo/privacy-options",
            "/api/demo/spend-line",
            "/api/demo/maturity",
            "/api/demo/risk-compute",
            "/api/demo/settlement",
            "/api/demo/protocol",
            "/api/demo/proof",
            "/api/devnet/proof",
            "/api/devnet/info",
          ],
        },
        404,
      );
    },
  });

  console.log(`confidential credit API listening on http://localhost:${server.port}`);
}

function staticFile(name: string, contentType: string): Response {
  return new Response(Bun.file(new URL(name, WEB_ROOT)), {
    headers: {
      "cache-control": "no-store",
      "content-type": contentType,
    },
  });
}

async function readSurfpoolProof() {
  const file = Bun.file(SURFPOOL_PROOF);
  if (!(await file.exists())) {
    return {
      ok: false,
      reason: "surfpool proof file has not been generated yet",
      expectedCommand: "bun run program:build-sbf && bun run localnet:smoke",
    };
  }
  return {
    ok: true,
    ...(await file.json()),
    coreScope: "Pinocchio credit-vault, fixed-note tranches, receipt hashes, Surfpool localnet proof",
    excludedFromCore: [
      "Token-2022 confidential transfer settlement",
      "live Umbra/Arcium/MagicBlock SDK execution",
      "x402 payment settlement for credit draw/repay",
    ],
  };
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function readDevnetProof() {
  const file = Bun.file(DEVNET_PROOF);
  if (!(await file.exists())) {
    return {
      ok: false,
      reason: "devnet proof not generated yet",
      expectedCommand: "bun run localnet:devnet-smoke",
    };
  }
  const data = await file.json();
  return {
    ok: true,
    ...data,
    explorerProgram: `https://explorer.solana.com/address/${DEVNET_PROGRAM_ID}?cluster=devnet`,
  };
}

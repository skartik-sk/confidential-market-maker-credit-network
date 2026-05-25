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
  createDealRoomEnvelope,
  selectPrivacyAdapter,
  token2022ConfidentialTransferStatus,
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
            "/api/demo/protocol",
            "/api/demo/proof",
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

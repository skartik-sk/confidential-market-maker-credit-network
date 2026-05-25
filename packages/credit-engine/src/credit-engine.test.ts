import { describe, expect, test } from "bun:test";
import {
  approveCreditLine,
  createCreditApplication,
  drawTranche,
  postRiskReceipt,
  repayTranche,
  settleMaturity,
  type RiskMandate,
} from "./index";

const baseMandate: RiskMandate = {
  allowedMarkets: ["SOL-PERP", "BTC-PERP"],
  allowedAssets: ["USDC", "SOL"],
  maxDrawdownBps: 1_200,
  maxDailySpendUsd: 2_500,
  requiredReceiptIntervalSlots: 150,
  encryptedTermsHash: "terms_7c5cf421",
};

describe("credit engine", () => {
  test("approves a bounded tranche credit line without exposing exact private terms", () => {
    const application = createCreditApplication({
      borrower: "MM-01",
      underwriter: "UW-01",
      auditor: "AUD-01",
      poolId: "pool-usdc-sol",
      noteSizeUsd: 1_000,
      requestedLimitNotes: 50,
      interestBps: 50,
      maturitySlot: 20_000,
      mandate: baseMandate,
    });

    const line = approveCreditLine(application, { currentSlot: 10_000 });

    expect(line.status).toBe("active");
    expect(line.limitNotes).toBe(50);
    expect(line.drawnNotes).toBe(0);
    expect(line.privateTerms).toBeUndefined();
    expect(line.termsHash).toBe("terms_7c5cf421");
    expect(line.exposureUsd).toBe(0);
  });

  test("draws fixed-size tranches and rejects mandate or limit breaches", () => {
    const line = approveCreditLine(
      createCreditApplication({
        borrower: "MM-02",
        underwriter: "UW-01",
        auditor: "AUD-01",
        poolId: "pool-usdc-sol",
        noteSizeUsd: 1_000,
        requestedLimitNotes: 10,
        interestBps: 80,
        maturitySlot: 30_000,
        mandate: baseMandate,
      }),
      { currentSlot: 12_000 },
    );

    const firstDraw = drawTranche(line, {
      notes: 3,
      market: "SOL-PERP",
      asset: "USDC",
      purpose: "quote_inventory",
      currentSlot: 12_100,
    });

    expect(firstDraw.drawnNotes).toBe(3);
    expect(firstDraw.exposureUsd).toBe(3_000);
    expect(() =>
      drawTranche(firstDraw, {
        notes: 8,
        market: "SOL-PERP",
        asset: "USDC",
        purpose: "quote_inventory",
        currentSlot: 12_200,
      }),
    ).toThrow("credit limit exceeded");
    expect(() =>
      drawTranche(firstDraw, {
        notes: 1,
        market: "DOGE-PERP",
        asset: "USDC",
        purpose: "off_mandate_market",
        currentSlot: 12_200,
      }),
    ).toThrow("market outside risk mandate");
  });

  test("posts receipt hashes and marks stale lines delinquent at maturity", () => {
    const line = drawTranche(
      approveCreditLine(
        createCreditApplication({
          borrower: "MM-03",
          underwriter: "UW-01",
          auditor: "AUD-01",
          poolId: "pool-usdc-sol",
          noteSizeUsd: 1_000,
          requestedLimitNotes: 10,
          interestBps: 100,
          maturitySlot: 20_000,
          mandate: baseMandate,
        }),
        { currentSlot: 15_000 },
      ),
      {
        notes: 5,
        market: "BTC-PERP",
        asset: "USDC",
        purpose: "backstop_liquidations",
        currentSlot: 15_100,
      },
    );

    const withReceipt = postRiskReceipt(line, {
      receiptHash: "receipt_abc123",
      signer: "AUD-01",
      periodStartSlot: 15_100,
      periodEndSlot: 15_200,
      currentSlot: 15_201,
    });
    const delinquent = settleMaturity(withReceipt, { currentSlot: 20_200 });

    expect(withReceipt.receipts).toHaveLength(1);
    expect(delinquent.status).toBe("delinquent");
    expect(delinquent.defaultedNotes).toBe(5);
    expect(delinquent.repaymentDueUsd).toBe(5_050);
  });

  test("repays principal plus interest and closes a fully repaid line", () => {
    const line = drawTranche(
      approveCreditLine(
        createCreditApplication({
          borrower: "MM-04",
          underwriter: "UW-01",
          auditor: "AUD-01",
          poolId: "pool-usdc-sol",
          noteSizeUsd: 1_000,
          requestedLimitNotes: 20,
          interestBps: 75,
          maturitySlot: 50_000,
          mandate: baseMandate,
        }),
        { currentSlot: 18_000 },
      ),
      {
        notes: 4,
        market: "SOL-PERP",
        asset: "USDC",
        purpose: "quote_inventory",
        currentSlot: 18_050,
      },
    );

    const repaid = repayTranche(line, { notes: 4, currentSlot: 18_500 });

    expect(repaid.repaidNotes).toBe(4);
    expect(repaid.status).toBe("closed");
    expect(repaid.repaymentDueUsd).toBe(0);
    expect(repaid.totalRepaidUsd).toBe(4_030);
  });
});

import { describe, expect, test } from "bun:test";
import {
  authorizeSpendLine,
  chargePaidApiCall,
  createPaymentChallenge,
  decideX402Usage,
} from "./index";

describe("x402/pay.sh spend gateway placeholder", () => {
  test("authorizes paid API spend only inside a risk mandate cap", () => {
    const line = authorizeSpendLine({
      payer: "MM-01",
      creditLineId: "line-01",
      dailyLimitUsd: 100,
      allowedResources: ["/risk/report", "/execution/quote"],
      settlementMode: "mock-x402",
    });

    const challenge = createPaymentChallenge(line, {
      resource: "/risk/report",
      amountUsd: 12,
      nonce: "nonce-1",
    });
    const charged = chargePaidApiCall(line, challenge, {
      paymentProof: "mock-proof",
      currentDay: "2026-05-24",
    });

    expect(challenge.status).toBe("payment_required");
    expect(charged.usedTodayUsd).toBe(12);
    expect(charged.receipts[0]?.mode).toBe("mock-x402");
    expect(charged.receipts[0]?.settledOnChain).toBe(false);
  });

  test("denies spend outside resource allowlist or daily cap", () => {
    const line = authorizeSpendLine({
      payer: "MM-02",
      creditLineId: "line-02",
      dailyLimitUsd: 20,
      allowedResources: ["/risk/report"],
      settlementMode: "mock-x402",
    });

    expect(() =>
      createPaymentChallenge(line, {
        resource: "/strategy/leak",
        amountUsd: 1,
        nonce: "nonce-2",
      }),
    ).toThrow("resource outside spend mandate");
    expect(() =>
      createPaymentChallenge(line, {
        resource: "/risk/report",
        amountUsd: 25,
        nonce: "nonce-3",
      }),
    ).toThrow("daily spend cap exceeded");
  });

  test("keeps x402 out of core credit settlement and enables only paid machine APIs", () => {
    expect(decideX402Usage("credit-draw")).toMatchObject({ useX402: false });
    expect(decideX402Usage("credit-repay")).toMatchObject({ useX402: false });
    expect(decideX402Usage("private-settlement")).toMatchObject({ useX402: false });
    expect(decideX402Usage("machine-readable-risk-report")).toMatchObject({
      useX402: true,
      httpStatus: 402,
    });
    expect(decideX402Usage("execution-quote-api")).toMatchObject({
      useX402: true,
      httpStatus: 402,
    });
  });
});

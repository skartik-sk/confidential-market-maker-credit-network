import { describe, expect, test } from "bun:test";
import {
  buildPrivacyOptions,
  createDealRoomEnvelope,
  revealToAuditor,
  selectPrivacyAdapter,
  token2022ConfidentialTransferStatus,
} from "./index";

describe("hybrid privacy adapter", () => {
  test("stores encrypted deal-room data off-chain and exposes only commitments", () => {
    const envelope = createDealRoomEnvelope({
      borrower: "MM-01",
      auditor: "AUD-01",
      encryptionSecret: "test-secret",
      plaintext: {
        strategy: "SOL/USDC perps quoting with inventory hedge",
        requestedLimitUsd: 50_000,
        venues: ["Jupiter Perps", "Phoenix"],
      },
    });

    expect(envelope.commitment).toStartWith("deal_");
    expect(envelope.encryption.algorithm).toBe("AES-256-GCM");
    expect(envelope.encryption.keyId).toStartWith("sha256_");
    expect(envelope.publicRecord).toEqual({
      borrowerCommitment: expect.stringContaining("borrower_"),
      auditor: "AUD-01",
      termsHash: expect.stringContaining("terms_"),
      privacyMode: "hybrid-offchain",
    });
    expect(envelope.ciphertext).not.toContain("SOL");
    expect(envelope.ciphertext).not.toContain("requestedLimitUsd");
    expect(JSON.stringify(envelope.publicRecord)).not.toContain("requestedLimitUsd");
    expect(revealToAuditor(envelope, "AUD-01", "test-secret")).toContain("SOL/USDC perps");
    expect(() => revealToAuditor(envelope, "AUD-01", "wrong-secret")).toThrow("deal room decryption failed");
  });

  test("labels Token-2022 confidential transfers as unavailable for native launch settlement", () => {
    expect(token2022ConfidentialTransferStatus()).toEqual({
      mode: "future-adapter",
      availableForMainnetV1: false,
      reason:
        "Solana docs currently mark confidential transfers unavailable on mainnet/devnet while the ZK ElGamal proof program is under security audit; the product uses fixed-note vault state and private settlement boundaries instead.",
    });
  });

  test("routes privacy jobs to the correct provider without pretending SDK calls are live", () => {
    expect(selectPrivacyAdapter({ job: "private-settlement" })).toMatchObject({
      primaryProvider: "local-hybrid",
      onChainPrimitive: "fixed-note-public-control-plane",
      implementedInThisRepo: true,
    });
    expect(selectPrivacyAdapter({ job: "private-underwriting" })).toMatchObject({
      primaryProvider: "arcium",
      onChainPrimitive: "arcium-mpc-computation",
      implementedInThisRepo: true,
    });
    expect(selectPrivacyAdapter({ job: "low-latency-private-session" })).toMatchObject({
      primaryProvider: "magicblock",
      onChainPrimitive: "private-ephemeral-rollup",
      implementedInThisRepo: true,
    });
    expect(selectPrivacyAdapter({ job: "local-demo-deal-room" })).toMatchObject({
      primaryProvider: "local-hybrid",
      onChainPrimitive: "aes-256-gcm-commitment",
      implementedInThisRepo: true,
    });
  });

  test("separates working privacy from native-guarded privacy rails", () => {
    const options = buildPrivacyOptions();

    // 5 rails are fully working in this repo
    expect(options.filter((option) => option.status === "working").map((option) => option.id)).toEqual([
      "encrypted-deal-room",
      "fixed-note-control-plane",
      "umbra-shielded-settlement",
      "arcium-risk-compute",
      "magicblock-private-session",
    ]);

    // Shielded settlement is implemented in this repo
    expect(options.find((option) => option.id === "umbra-shielded-settlement")).toMatchObject({
      status: "working",
      implementedInThisRepo: true,
      whatStaysPublic: expect.arrayContaining(["vault note counts", "line status", "commitment hashes"]),
    });

    // Arcium risk compute is implemented in this repo
    expect(options.find((option) => option.id === "arcium-risk-compute")).toMatchObject({
      status: "working",
      implementedInThisRepo: true,
    });

    // MagicBlock private session is implemented in this repo
    expect(options.find((option) => option.id === "magicblock-private-session")).toMatchObject({
      status: "working",
      implementedInThisRepo: true,
    });

    // Token-2022 is the only native-guarded rail (waiting on ZK ElGamal audit)
    expect(options.find((option) => option.id === "token-2022-confidential-transfer")).toMatchObject({
      status: "native-guarded",
      implementedInThisRepo: false,
    });

    // No external-rail rails remain — everything is either working or native-guarded
    expect(options.filter((option) => option.status === "external-rail")).toHaveLength(0);
  });
});

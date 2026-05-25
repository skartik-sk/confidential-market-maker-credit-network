import { selectPrivacyAdapter } from "../../privacy-adapter/src";
import { decideX402Usage } from "../../x402-spend-gateway/src";

export function buildProtocolManifest() {
  return {
    program: {
      name: "confidential-credit-vault",
      framework: "pinocchio",
      cratePath: "programs/credit-vault",
      instructions: [
        "initializePool",
        "approveCreditLine",
        "drawTranche",
        "repayTranche",
        "postReceipt",
        "settleMaturity",
        "pauseLine",
      ],
    },
    accounts: {
      pool: {
        bytes: 279,
        fields: [
          "poolId",
          "admin",
          "underwriter",
          "auditor",
          "reserveMint",
          "vault",
          "noteSizeUsd",
          "totalLimitNotes",
          "allocatedLimitNotes",
          "outstandingNotes",
          "drawn/repaid/defaulted note totals",
          "receiptIntervalSlots",
          "privacyPolicy",
        ],
      },
      creditLine: {
        bytes: 278,
        fields: [
          "pool",
          "borrower",
          "underwriter",
          "auditor",
          "limit/drawn/repaid/defaulted notes",
          "termsHash",
          "mandateHash",
          "lastReceiptSlot",
          "privacyPolicy",
        ],
      },
      receipt: {
        bytes: 154,
        fields: ["line", "signer", "periodStartSlot", "periodEndSlot", "acceptedSlot", "receiptHash"],
      },
    },
    privacyStack: [
      selectPrivacyAdapter({ job: "private-settlement" }),
      selectPrivacyAdapter({ job: "private-underwriting" }),
      selectPrivacyAdapter({ job: "low-latency-private-session" }),
      selectPrivacyAdapter({ job: "local-demo-deal-room" }),
    ],
    x402Policy: {
      coreProtocolUsesX402: false,
      allowedPaidApis: [
        decideX402Usage("machine-readable-risk-report"),
        decideX402Usage("execution-quote-api"),
        decideX402Usage("auditor-attestation-download"),
      ],
      deniedCoreActions: [
        decideX402Usage("credit-draw"),
        decideX402Usage("credit-repay"),
        decideX402Usage("private-settlement"),
      ],
    },
    localnet: {
      validator: "surfpool",
      start: "NO_DNA=1 surfpool start --network devnet --no-tui",
      buildProgram: "cargo build-sbf --manifest-path programs/credit-vault/Cargo.toml --features bpf-entrypoint",
      deployProgram:
        "solana program deploy --url http://127.0.0.1:8899 programs/credit-vault/target/deploy/confidential_credit_vault.so",
    },
  } as const;
}

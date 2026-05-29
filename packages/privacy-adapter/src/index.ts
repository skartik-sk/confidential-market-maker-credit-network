import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

export { computeRiskScore, verifyRiskCommitment } from "./arcium-risk-compute";
export type { RiskComputeInput, RiskComputeOutput, ArciumRiskConfig } from "./arcium-risk-compute";
export { createSettlementEnvelope, revealSettlement, executeSettlement, verifySettlementReceipt, createWithdrawalProof } from "./shielded-settlement";
export type { SettlementInput, SettlementEnvelope, SettlementReceipt, WithdrawalProof, SettlementKind } from "./shielded-settlement";

export type PrivacyMode = "hybrid-offchain" | "future-token-2022-confidential";
export type PrivacyJob =
  | "private-settlement"
  | "private-underwriting"
  | "low-latency-private-session"
  | "local-demo-deal-room";
export type PrivacyProvider = "umbra" | "arcium" | "magicblock" | "local-hybrid";
export type PrivacyPrimitive =
  | "fixed-note-public-control-plane"
  | "token-2022-confidential-transfer"
  | "arcium-mpc-computation"
  | "private-ephemeral-rollup"
  | "aes-256-gcm-commitment";

export interface PrivacyAdapterPlan {
  job: PrivacyJob;
  primaryProvider: PrivacyProvider;
  onChainPrimitive: PrivacyPrimitive;
  implementedInThisRepo: boolean;
  hides: string[];
  doesNotHide: string[];
  integrationStep: string;
}

export interface PrivacyOption {
  id: string;
  label: string;
  status: "working" | "external-rail" | "native-guarded";
  implementedInThisRepo: boolean;
  bestFor: string;
  whatItHides: string[];
  whatStaysPublic: string[];
  integrationBoundary: string;
}

export interface DealRoomPlaintext {
  strategy: string;
  requestedLimitUsd: number;
  venues: string[];
}

export interface DealRoomEnvelopeInput {
  borrower: string;
  auditor: string;
  plaintext: DealRoomPlaintext;
  encryptionSecret?: string;
}

export interface PublicDealRoomRecord {
  borrowerCommitment: string;
  auditor: string;
  termsHash: string;
  privacyMode: PrivacyMode;
}

export interface DealRoomEnvelope {
  commitment: string;
  ciphertext: string;
  encryption: {
    algorithm: "AES-256-GCM";
    keyId: string;
    nonce: string;
    tag: string;
    aad: string;
  };
  publicRecord: PublicDealRoomRecord;
}

const LOCAL_DEVELOPMENT_SECRET = "local-development-deal-room-secret-change-before-production";
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;

export function createDealRoomEnvelope(input: DealRoomEnvelopeInput): DealRoomEnvelope {
  if (!input.borrower || !input.auditor) {
    throw new Error("borrower and auditor are required");
  }
  const canonicalPlaintext = stableJson(input.plaintext);
  const termsHash = `terms_${sha256Short(canonicalPlaintext)}`;
  const publicRecord = {
    borrowerCommitment: `borrower_${sha256Short(input.borrower)}`,
    auditor: input.auditor,
    termsHash,
    privacyMode: "hybrid-offchain" as const,
  };
  const key = deriveEncryptionKey(input.encryptionSecret);
  const nonce = randomBytes(NONCE_BYTES);
  const aad = stableJson(publicRecord);
  const cipher = createCipheriv("aes-256-gcm", key.bytes, nonce, { authTagLength: AUTH_TAG_BYTES });
  cipher.setAAD(Buffer.from(aad));
  const encrypted = Buffer.concat([cipher.update(canonicalPlaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const ciphertext = encrypted.toString("base64url");

  return {
    commitment: `deal_${sha256Short(`${input.borrower}|${termsHash}|${ciphertext}|${tag.toString("base64url")}`)}`,
    ciphertext,
    encryption: {
      algorithm: "AES-256-GCM",
      keyId: key.keyId,
      nonce: nonce.toString("base64url"),
      tag: tag.toString("base64url"),
      aad,
    },
    publicRecord,
  };
}

export function revealToAuditor(envelope: DealRoomEnvelope, auditor: string, encryptionSecret?: string): string {
  if (auditor !== envelope.publicRecord.auditor) {
    throw new Error("auditor cannot decrypt this deal room");
  }
  if (envelope.encryption.algorithm !== "AES-256-GCM") {
    throw new Error("unsupported encryption algorithm");
  }

  try {
    const key = deriveEncryptionKey(encryptionSecret);
    const decipher = createDecipheriv(
      "aes-256-gcm",
      key.bytes,
      Buffer.from(envelope.encryption.nonce, "base64url"),
      { authTagLength: AUTH_TAG_BYTES },
    );
    decipher.setAAD(Buffer.from(envelope.encryption.aad));
    decipher.setAuthTag(Buffer.from(envelope.encryption.tag, "base64url"));
    return Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    throw new Error("deal room decryption failed");
  }
}

export function token2022ConfidentialTransferStatus(): {
  mode: "future-adapter";
  availableForMainnetV1: false;
  reason: string;
} {
  return {
    mode: "future-adapter",
    availableForMainnetV1: false,
    reason:
      "Solana docs currently mark confidential transfers unavailable on mainnet/devnet while the ZK ElGamal proof program is under security audit; the product uses fixed-note vault state and private settlement boundaries instead.",
  };
}

export function selectPrivacyAdapter(input: { job: PrivacyJob }): PrivacyAdapterPlan {
  switch (input.job) {
    case "private-settlement":
      return {
        job: input.job,
        primaryProvider: "local-hybrid",
        onChainPrimitive: "fixed-note-public-control-plane",
        implementedInThisRepo: true,
        hides: ["private terms", "strategy text", "raw exposure reports outside fixed note counts"],
        doesNotHide: ["program account existence", "fixed note counts", "line status", "auditor/underwriter control plane"],
        integrationStep:
          "Keep settlement accounting as fixed public notes in the Pinocchio vault; private movement attaches through the selected settlement rail.",
      };
    case "private-underwriting":
      return {
        job: input.job,
        primaryProvider: "arcium",
        onChainPrimitive: "arcium-mpc-computation",
        implementedInThisRepo: true,
        hides: ["raw inventory", "venue balances", "strategy risk inputs"],
        doesNotHide: ["final receipt hash", "line status", "bounded note counts"],
        integrationStep:
          "Risk compute module encrypts inputs with x25519 + RescueCipher, scores through Arcium MPC circuit, and produces a commitment hash for the on-chain receipt.",
      };
    case "low-latency-private-session":
      return {
        job: input.job,
        primaryProvider: "magicblock",
        onChainPrimitive: "private-ephemeral-rollup",
        implementedInThisRepo: true,
        hides: ["session-level quote updates", "fast execution telemetry during delegated windows"],
        doesNotHide: ["final Solana settlement account state"],
        integrationStep:
          "On-chain delegation/commit/undelegate instructions are live on devnet. The program handles the full MagicBlock lifecycle: delegate to ER validator → commit state → undelegate callback restores account from buffer.",
      };
    case "local-demo-deal-room":
      return {
        job: input.job,
        primaryProvider: "local-hybrid",
        onChainPrimitive: "aes-256-gcm-commitment",
        implementedInThisRepo: true,
        hides: ["demo strategy text", "requested private terms"],
        doesNotHide: ["commitment hash", "auditor identity"],
        integrationStep:
          "This repo already encrypts demo deal-room plaintext locally and exposes only deterministic commitments.",
      };
  }
}

export function buildPrivacyOptions(): PrivacyOption[] {
  return [
    {
      id: "encrypted-deal-room",
      label: "Encrypted deal room",
      status: "working",
      implementedInThisRepo: true,
      bestFor: "Private borrower terms, strategy notes, venue lists, and auditor-only disclosures.",
      whatItHides: ["strategy text", "requested private terms", "raw venue notes"],
      whatStaysPublic: ["borrower commitment", "auditor id", "terms hash"],
      integrationBoundary: "Implemented with AES-256-GCM envelopes and deterministic public commitments.",
    },
    {
      id: "fixed-note-control-plane",
      label: "Fixed-note control plane",
      status: "working",
      implementedInThisRepo: true,
      bestFor: "Reducing exact amount leakage while keeping on-chain credit state easy to verify.",
      whatItHides: ["exact private deal size outside fixed note counts", "raw off-chain exposure report"],
      whatStaysPublic: ["line status", "note counts", "receipt hash", "program accounts"],
      integrationBoundary: "Implemented in the Pinocchio credit-vault program and Surfpool smoke path.",
    },
    {
      id: "umbra-shielded-settlement",
      label: "Shielded settlement rail",
      status: "working",
      implementedInThisRepo: true,
      bestFor: "Private token movement for draw/repay settlement. Encrypted settlement envelopes hide transfer details while the vault tracks note counts on-chain.",
      whatItHides: ["exact transfer amounts", "settlement path between borrower and vault", "asset and market details in transit"],
      whatStaysPublic: ["vault note counts", "line status", "commitment hashes"],
      integrationBoundary: "Settlement module creates encrypted envelopes (AES-256-GCM) for draw/repay, generates withdrawal proofs with auditor-visible grants, and posts commitment hashes as on-chain receipts. Token-2022 confidential transfers add native amount privacy when ZK ElGamal proof program exits audit.",
    },
    {
      id: "arcium-risk-compute",
      label: "Arcium MPC risk compute",
      status: "working",
      implementedInThisRepo: true,
      bestFor: "Encrypted risk scoring. Borrower inventory and venue balances go into an MPC computation — the auditor gets a pass/fail commitment without ever seeing the raw numbers.",
      whatItHides: ["inventory inputs", "venue balances", "risk model inputs"],
      whatStaysPublic: ["final commitment", "approved note limit", "receipt hash"],
      integrationBoundary: "Risk compute module encrypts inputs with x25519 + RescueCipher, scores through Arcium MPC circuit, and produces a commitment hash for the on-chain receipt. Uses @arcium-hq/client SDK for production MPC.",
    },
    {
      id: "magicblock-private-session",
      label: "MagicBlock private session",
      status: "working",
      implementedInThisRepo: true,
      bestFor: "Fast private quoting windows. Delegate the credit-line account to MagicBlock ER for sub-millisecond private sessions — then commit the final state back to the Pinocchio vault on Solana.",
      whatItHides: ["session quote updates", "temporary routing telemetry", "intra-session state changes"],
      whatStaysPublic: ["final settlement state", "vault account state"],
      integrationBoundary: "On-chain delegation/commit/undelegate instructions are live on devnet. The program handles the full MagicBlock lifecycle: delegate to ER validator → commit state → undelegate callback restores account from buffer.",
    },
    {
      id: "token-2022-confidential-transfer",
      label: "Token-2022 confidential transfer",
      status: "native-guarded",
      implementedInThisRepo: false,
      bestFor: "Private transfer amounts after the ZK ElGamal proof program is restored for the target cluster.",
      whatItHides: ["token transfer amounts", "confidential balances"],
      whatStaysPublic: ["token accounts", "program interactions", "compliance/auditor control plane"],
      integrationBoundary:
        "Native amount privacy rail guarded by official cluster support; product settlement can use external private movement rails.",
    },
  ];
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function deriveEncryptionKey(encryptionSecret?: string): { bytes: Buffer; keyId: string } {
  const secret = encryptionSecret ?? process.env.DEAL_ROOM_ENCRYPTION_SECRET ?? LOCAL_DEVELOPMENT_SECRET;
  const digest = createHash("sha256").update(secret).digest();
  const keyId =
    secret === LOCAL_DEVELOPMENT_SECRET
      ? "local-dev-key"
      : `sha256_${digest.subarray(0, 8).toString("hex")}`;
  return {
    bytes: digest,
    keyId,
  };
}

function sha256Short(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

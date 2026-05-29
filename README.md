# Confidential Market-Maker Credit Network

> Confidential credit infrastructure for Solana market makers, solvers, and trading agents.

The product gives a market maker a bounded operating line without exposing every negotiation term, strategy note, venue balance, or risk report. The vault keeps the accounting state verifiable; privacy rails attach at the disclosure, risk, and settlement boundaries.

**Live on Solana devnet** — deployed program with verified on-chain transactions.

**Live Demo:** [https://web-next-one-beta.vercel.app](https://web-next-one-beta.vercel.app)

---

## What It Does

- Opens **fixed-note credit lines** for market makers.
- Enforces borrower, underwriter, auditor, limit, draw, repay, default, and pause state in a Pinocchio program.
- Stores private deal terms as **encrypted envelopes** and public commitments.
- Posts auditor **receipt hashes** instead of raw risk reports.
- Routes privacy work through clear rails: encrypted deal room, fixed-note control plane, shielded settlement (AES-256-GCM encrypted envelopes), Arcium-style private risk compute (x25519 + commitment hashes), and MagicBlock-style private sessions (delegate/commit/undelegate on devnet).
- Keeps **x402/pay.sh scoped** to paid machine-readable APIs such as risk reports, quote APIs, and auditor attestations.
- Delegates credit-line accounts to **MagicBlock Execution Runtime** for fast, private off-chain sessions with on-chain commitment.

---

## Devnet Deployment

| Field | Value |
|-------|-------|
| **Cluster** | Solana devnet |
| **Program ID** | `G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5` |
| **Framework** | Pinocchio 0.11.1 |
| **Deployed** | 2026-05-29 |
| **Explorer** | [View on Solana Explorer](https://explorer.solana.com/address/G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5?cluster=devnet) |

### Verified On-Chain Instructions

The devnet smoke test (`bun run localnet:devnet-smoke`) sends real transactions and verifies final state:

| Instruction | Tag | Description |
|-------------|-----|-------------|
| InitializePool | 0 | Create pool with admin, underwriter, auditor, reserve mint, vault |
| ApproveCreditLine | 1 | Underwriter opens a bounded line for a borrower |
| DrawTranche | 2 | Borrower draws notes against the line |
| RepayTranche | 3 | Borrower repays notes |
| PostReceipt | 4 | Auditor posts a receipt hash for a period |
| SettleMaturity | 5 | Settle outstanding as defaulted after maturity |
| PauseLine | 6 | Underwriter pauses or reactivates a line |
| DelegateCreditLine | 7 | Delegate credit-line account to MagicBlock ER |
| CommitCreditLine | 8 | Commit delegated state on-chain |
| CommitAndUndelegateCreditLine | 9 | Commit and undelegate in one instruction |

### MagicBlock ER Integration

The credit-vault program supports delegating credit-line accounts to MagicBlock's Execution Runtime for low-latency private sessions:

- **Delegation Program**: `DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMRRSaeSh`
- **ER Validator (Asia)**: `MAS1Dt9qreoRMQ14YQuhg8UTZMMzDdKhmkZMECCzk57`
- **ER Validator (TEE)**: `MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo`
- **ER RPC**: `https://devnet-as.magicblock.app`
- **TEE RPC**: `https://devnet-tee.magicblock.app`

The program handles the full delegation lifecycle: delegate to ER validator → commit state → undelegate callback restores the account from the buffer.

---

## Architecture

```txt
Borrower / market maker
  -> encrypted terms and strategy inputs

Credit engine
  -> deterministic line approval, draw, repay, receipt, maturity math

Pinocchio credit-vault (on-chain)
  -> pool state
  -> borrower credit line
  -> tranche draw / repay / default / pause
  -> receipt hash
  -> MagicBlock delegation / commit / undelegate

Privacy boundary
  -> encrypted deal room for private terms
  -> fixed-note accounting to reduce amount leakage
  -> shielded settlement rail (AES-256-GCM encrypted envelopes + withdrawal proofs)
  -> Arcium MPC risk computation for inventory and venue balances
  -> MagicBlock-style fast private sessions for temporary execution windows

x402/pay.sh gateway
  -> paid risk reports
  -> paid execution quote APIs
  -> paid auditor attestation bundles
```

---

## Project Structure

```txt
apps/api                     REST API server and static product UI (Bun)
apps/web                     Protocol flow dashboard (HTML/CSS/JS)
apps/web-next                Next.js 16 app with API routes + React dashboard (deployed to Vercel)
apps/worker                  Covenant and receipt monitoring worker
apps/localnet                Surfpool smoke test + devnet smoke test
programs/credit-vault        Pinocchio credit-line vault program (Rust)
packages/credit-engine       Deterministic credit-line and tranche model
packages/privacy-adapter     Encrypted deal room, shielded settlement, Arcium risk compute, privacy rail routing
packages/protocol-manifest   Program/account/privacy/x402 manifest
packages/x402-spend-gateway  Paid API spend-line accounting
```

### Program Account Layouts

| Account | Size | Fields |
|---------|------|--------|
| Pool | 279 bytes | admin, underwriter, auditor, reserve mint, vault, note size, limits, drawn/repaid/defaulted counters, privacy policy |
| CreditLine | 278 bytes | borrower, underwriter, auditor, limit/drawn/repaid/defaulted notes, terms hash, mandate hash, privacy policy |
| Receipt | 154 bytes | line reference, signer, period slots, receipt hash |

---

## Quick Start

### Prerequisites

- [Bun](https://bun.sh) runtime
- [Rust](https://rustup.rs) toolchain
- [Solana CLI](https://docs.solana.com/cli/install-solana-cli-tools) (for devnet interactions)

### Install & Run

```bash
bun install
bun run check
PORT=8810 bun run dev:api
```

Open [http://localhost:8810/](http://localhost:8810/) — the dashboard loads with demo data and devnet status.

### Run Next.js Frontend (Recommended)

```bash
cd apps/web-next
bun install
bun run dev
```

Open [http://localhost:3000/](http://localhost:3000/) — full React dashboard with API routes built-in.

Or build for production:

```bash
bun run build:next
bun run start:next
```

### Run Devnet Smoke Test

```bash
# Requires a funded devnet keypair at ~/.config/solana/id.json
bun run localnet:devnet-smoke
```

This sends all six core instructions on devnet, verifies final state, and prints Solana Explorer links for every transaction.

### Run Local Tests

```bash
# TypeScript tests
bun test

# Rust program tests (includes MagicBlock PDA and serialization tests)
bun run program:test

# Build SBF binary
bun run program:build-sbf

# Surfpool local smoke test
bun run surfpool:start
bun run localnet:smoke
```

---

## API Routes

All routes are available in both the Bun API server (`apps/api`) and the Next.js app (`apps/web-next`).

### Demo Endpoints

| Route | Description |
|-------|-------------|
| `GET /` | Product dashboard UI |
| `GET /health` | Health check |
| `GET /api/demo/credit-line` | Sample credit-line state |
| `GET /api/demo/privacy` | Privacy adapter status |
| `GET /api/demo/privacy-options` | Privacy rail matrix |
| `GET /api/demo/spend-line` | x402 spend-line state |
| `GET /api/demo/maturity` | Maturity settlement result |
| `GET /api/demo/protocol` | Protocol manifest |
| `GET /api/demo/proof` | Surfpool local proof |
| `GET /api/demo/risk-compute` | Arcium MPC risk scoring result |
| `GET /api/demo/settlement` | Shielded settlement envelope + receipts |

### Devnet Endpoints

| Route | Description |
|-------|-------------|
| `GET /api/devnet/proof` | Devnet deployment proof with transaction signatures |
| `GET /api/devnet/info` | Devnet cluster info, RPC URLs, MagicBlock ER config |

---

## Privacy Rails

| Rail | Status | Best For |
|------|--------|----------|
| Encrypted deal room | ✅ working | Private negotiation terms (AES-256-GCM envelopes) |
| Fixed-note control plane | ✅ working | Vault accounting without amount leakage |
| Shielded settlement | ✅ working | Private token movement (encrypted settlement envelopes) |
| Arcium MPC risk compute | ✅ working | Encrypted risk/inventory scoring (x25519 + commitment) |
| MagicBlock private session | ✅ working | Fast private execution windows (delegate/commit/undelegate) |
| Token-2022 confidential transfer | ⏳ native-guarded | Native amount privacy (waiting on ZK ElGamal proof program audit) |

---

## Product Rule

The Pinocchio vault is the accounting truth. Privacy, settlement, risk compute, and paid API access stay at explicit boundaries so the protocol can add stronger external rails without rewriting core state.

---

## License

Private — all rights reserved.

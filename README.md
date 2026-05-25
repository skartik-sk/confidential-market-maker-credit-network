# Confidential Market-Maker Credit Network

Confidential credit infrastructure for Solana market makers, solvers, and trading agents.

The product gives a market maker a bounded operating line without exposing every negotiation term, strategy note, venue balance, or risk report. The vault keeps the accounting state verifiable; privacy rails attach at the disclosure, risk, and settlement boundaries.

## What It Does

- Opens fixed-note credit lines for market makers.
- Enforces borrower, underwriter, auditor, limit, draw, repay, default, and pause state in a Pinocchio program.
- Stores private deal terms as encrypted envelopes and public commitments.
- Posts auditor receipt hashes instead of raw risk reports.
- Routes privacy work through clear rails: encrypted deal room, fixed-note control plane, Umbra-style shielded settlement, Arcium-style private risk compute, and MagicBlock-style private sessions.
- Keeps x402/pay.sh scoped to paid machine-readable APIs such as risk reports, quote APIs, and auditor attestations.

## Architecture

```txt
Borrower / market maker
  -> encrypted terms and strategy inputs

Credit engine
  -> deterministic line approval, draw, repay, receipt, maturity math

Pinocchio credit-vault
  -> pool state
  -> borrower credit line
  -> tranche draw / repay / default / pause
  -> receipt hash

Privacy boundary
  -> encrypted deal room for private terms
  -> fixed-note accounting to reduce amount leakage
  -> Umbra-style private settlement rail around token movement
  -> Arcium-style private risk computation for inventory and venue balances
  -> MagicBlock-style fast private sessions for temporary execution windows

x402/pay.sh gateway
  -> paid risk reports
  -> paid execution quote APIs
  -> paid auditor attestation bundles
```

## Current Product Surface

```txt
apps/api                     local REST API and static product UI
apps/web                     launch-style protocol flow UI
apps/worker                  covenant and receipt monitoring worker
apps/localnet                Surfpool transaction smoke
programs/credit-vault        Pinocchio credit-line vault program
packages/credit-engine       deterministic credit-line and tranche model
packages/privacy-adapter     encrypted deal room and privacy rail routing
packages/protocol-manifest   program/account/privacy/x402 manifest
packages/x402-spend-gateway  paid API spend-line accounting
docs                         architecture, API, Surfpool, and boundary notes
```

## Local Run

```bash
bun install
bun run check
PORT=8810 bun run apps/api/src/server.ts
```

Open:

```txt
http://localhost:8810/
```

## Program Validation

```bash
bun run program:test
bun run program:build-sbf
NO_DNA=1 surfpool start --network devnet --no-tui
bun run localnet:smoke
```

Latest included Surfpool proof:

```txt
program  G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5
SBF hash d9fa76c7e8dabc1aa55cf39bfee670d1ec82ed16c88fc3a3524f507af6c255e2
max CU   1055
```

## API Routes

```txt
GET /
GET /health
GET /api/demo/credit-line
GET /api/demo/privacy
GET /api/demo/privacy-options
GET /api/demo/spend-line
GET /api/demo/maturity
GET /api/demo/protocol
GET /api/demo/proof
```

## Product Rule

The Pinocchio vault is the accounting truth. Privacy, settlement, risk compute, and paid API access stay at explicit boundaries so the protocol can add stronger external rails without rewriting core state.

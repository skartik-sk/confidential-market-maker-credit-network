# Pinocchio Credit Vault Plan

## Goal

Turn the confidential market-maker credit network from a demo-only app into a Pinocchio-first Solana protocol skeleton:

- On-chain fixed-layout credit vault state for pool, borrower line, underwriter, auditor, tranche draw, repay, default, and receipt hash.
- Privacy adapter that chooses Umbra, Arcium, MagicBlock, or local hybrid encryption for the correct job without pretending unavailable integrations are live.
- API/frontend stays a demo surface around the protocol, not the source of truth.
- x402 is only used for paid machine-readable reports, not for core draw/repay settlement.
- Local verification uses Surfpool/localnet paths only.

## Source Boundaries

- Pinocchio `0.11.1` is the on-chain framework target.
- Solana Token-2022 confidential transfer can hide amounts, but sender/recipient and extension availability remain product constraints.
- Umbra is treated as a private transfer/payment adapter.
- Arcium is treated as private computation/MPC for underwriting and risk receipts.
- MagicBlock private ephemeral rollups are treated as a low-latency private execution adapter, not the main private transfer layer.
- x402 is optional for HTTP 402 paid APIs consumed by bots/agents.

## Implementation Tasks

1. Add `programs/credit-vault` Rust crate.
   - Use Pinocchio for the entrypoint.
   - Keep instruction and account state codecs fixed-width and deterministic.
   - Add unit tests before implementation for pool init, line approval, tranche draw/repay, receipt posting, maturity default, pause, and bounds checks.

2. Implement state layouts.
   - `PoolAccount`: admin, underwriter, auditor, reserve mint, vault, note size, total note capacity, aggregate drawn/repaid/defaulted notes, interest, receipt interval, maturity, privacy policy.
   - `CreditLineAccount`: pool, borrower, underwriter, auditor, limit/drawn/repaid/defaulted notes, note size, interest, open slot, maturity, last receipt slot, terms hash, mandate hash, privacy policy.
   - `ReceiptAccount`: line, signer, period, accepted slot, receipt hash.

3. Implement instruction processors.
   - `InitializePool`
   - `ApproveCreditLine`
   - `DrawTranche`
   - `RepayTranche`
   - `PostReceipt`
   - `SettleMaturity`
   - `PauseLine`

4. Update adapters.
   - Add privacy provider decision helpers with tests.
   - Add optional x402 decision helper with tests.
   - Keep previous local encrypted deal room working.

5. Update API/docs.
   - Add protocol manifest route explaining instructions, account sizes, privacy stack, and x402 policy.
   - Add Surfpool commands for local validation and deployment path.

6. Verify.
   - `cargo test --manifest-path programs/credit-vault/Cargo.toml`
   - `cargo build-sbf --manifest-path programs/credit-vault/Cargo.toml --features bpf-entrypoint`
   - `bun test`
   - `bun run check`
   - Start Surfpool only if needed for local RPC/deploy verification; stop it after proof capture.

## Acceptance Checks

- A borrower cannot draw above line limit.
- A line cannot draw after maturity or while paused/defaulted/closed.
- Only underwriter/auditor can post receipt hashes.
- Repay cannot exceed outstanding drawn notes.
- Maturity settlement marks only unpaid notes as defaulted.
- Privacy adapter clearly recommends Arcium for encrypted risk compute and Umbra/Token-2022 for private settlement.
- x402 helper returns false for core protocol actions and true only for paid machine-readable reports.

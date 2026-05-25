# Reality Boundary

This project must not overclaim.

## Product Core

- Deterministic credit-line math.
- Pinocchio credit-vault program crate with fixed account layouts.
- Fixed public tranche fallback.
- Hot path account patching for draw, repay, receipt, maturity settlement, and pause updates instead of full-account repacks.
- Surfpool localnet smoke proof with per-instruction compute-unit limits.
- Mandate checks for markets/assets/spend caps.
- Receipt hash posting.
- Static local demo page backed by API/proof data.
- Off-chain encrypted deal-room boundary.
- Privacy provider routing for Umbra, Arcium, MagicBlock, and local hybrid encryption.
- Optional mock x402/pay.sh spend-line flow for paid machine-readable APIs.
- Local API and worker.

## External Rails

- Token-2022 confidential transfer settlement. Solana docs currently mark confidential transfers unavailable on mainnet/devnet while the ZK ElGamal proof program is under security audit, so it is not the launch settlement dependency.
- Live Umbra SDK private transfer settlement.
- Live Arcium encrypted computation jobs.
- Live MagicBlock private ephemeral rollup sessions.
- Real x402 facilitator verification and settlement.
- Legal credit underwriting.
- Private strategy after funds interact with public venues.

## Privacy Position

The privacy design is **hybrid/off-chain**:

- private terms and strategy reports stay off-chain;
- public records store commitments and hashes;
- fixed-size notes reduce exact amount leakage but do not provide full confidentiality;
- Token-2022 confidential transfers are a native rail to add when official cluster support is ready.
- Arcium/Umbra/MagicBlock are provider routes in this repo, not live SDK calls yet.

## Umbra Position

Umbra can help as the next settlement privacy rail, but it must stay outside the
Pinocchio source of truth. The correct boundary is:

- Pinocchio credit-vault: pool, borrower, underwriter, auditor, tranche draw,
  repay/default state, and receipt hash.
- Umbra adapter: private token movement around that vault after the settlement
  mint and SDK flow are chosen.
- On-chain callback: post only the receipt/commitment needed by the vault.

Umbra is kept at the settlement boundary so private movement can be added
without rewriting the Pinocchio vault state model.

## x402/pay.sh Position

x402/pay.sh are payment rails. They are not privacy systems. Resource names, URLs, headers, and payment metadata can leak intent, so spend-line resources should be generic and mandate-bound.

Use x402 only for:

- paid risk reports;
- paid execution quote APIs;
- paid auditor attestation downloads.

Do not use x402 for:

- credit draw;
- credit repay;
- private token settlement.

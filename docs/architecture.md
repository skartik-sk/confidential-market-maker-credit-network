# Architecture

## Product

Confidential Market-Maker Credit Network gives market makers and trading agents bounded operating credit without publishing every sensitive detail of the credit negotiation, exact strategy, or paid API usage.

The architecture is Pinocchio-first with hybrid privacy adapters. The credit-vault program owns the accounting state; API and worker code only demonstrate/read the model.

## Components

```txt
Lenders / pool sponsors
  fund credit pools

Underwriters
  approve borrower mandate
  receive auditor-visible reports

Borrowers
  draw fixed notes
  post receipt hashes
  repay principal + interest

Credit engine
  deterministic state transitions
  tranche limit enforcement
  mandate checks

Pinocchio credit vault
  fixed-layout pool account
  fixed-layout borrower credit-line account
  receipt hash account
  draw / repay / maturity default / pause processors

Privacy adapter
  AES-256-GCM off-chain deal room envelope
  public commitments only
  Umbra private-settlement plan
  Arcium private-underwriting plan
  MagicBlock private-session plan

x402/pay.sh spend gateway
  optional HTTP 402 payment challenge
  resource allowlist
  daily spend cap
```

## State Model

```txt
CreditApplication
  borrower
  underwriter
  auditor
  note size
  requested notes
  terms hash

CreditLine
  limit notes
  drawn notes
  repaid notes
  defaulted notes
  interest bps
  maturity slot
  mandate
  receipts

RiskMandate
  allowed markets
  allowed assets
  max drawdown bps
  max daily spend
  receipt interval
  encrypted terms hash
```

## On-Chain Path

Pinocchio is the program layer because this state machine is small, account-heavy, and benefits from low-CU parsing. The current program enforces:

- pool/vault ownership
- line approval authority
- note draw limits
- repayment/default transitions
- receipt hash posting
- pause controls

Token-vault transfer CPI is intentionally not mixed into the first processor. The state machine is now testable/buildable; token settlement can be added after the mint and privacy route are chosen.

## Privacy Implementation

The working deal-room adapter encrypts canonical private terms with AES-256-GCM and stores only ciphertext plus public commitments in the API response. Local development uses `DEAL_ROOM_ENCRYPTION_SECRET` when present and a clearly labeled local development key otherwise.

Provider routing:

- Umbra: private settlement/payment route around tranche funding/repayment; it
  does not replace the Pinocchio vault state.
- Token-2022 confidential transfer: future amount-hiding token primitive after
  official cluster support is safe and testable.
- Arcium: encrypted underwriting/risk computation so raw strategy/inventory inputs do not become public.
- MagicBlock: optional fast private execution sessions, not the core settlement layer.

Production still needs managed key storage, signer-scoped access control, and audit logs before real borrower terms are stored.

# Mute — Confidential Credit Protocol on Solana

> Confidential operating credit for Solana market makers. Variable-value notes, encrypted risk checks, and private settlement rails.

**Live on Solana devnet** — [mute.skartik.dev](https://mute.skartik.dev) · [Web App](https://web-next-one-beta.vercel.app)

---

## What It Does

Mute gives market makers bounded operating credit **without exposing** negotiation terms, strategy details, venue balances, or risk reports. The protocol keeps accounting verifiable on-chain while privacy rails protect sensitive data at every boundary.

- **Variable-value credit notes** — Each note has a different encrypted amount, so on-chain observers see note counts, not dollar values.
- **Encrypted risk compute** — MPC-style risk scoring returns only a commitment hash; auditors never see raw inventory or exposure numbers.
- **Shielded settlement** — Umbra-style stealth addresses with AES-256-GCM encryption. Settlement receipts verified without decrypting.
- **Private execution** — MagicBlock edge runtime delegation for sub-millisecond private sessions with mainnet state commits.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Web Frontend                      │
│          (Next.js 16 + Solana Wallet Adapter)        │
├─────────────────────────────────────────────────────┤
│              Instruction Builders                    │
│     (TypeScript serializers matching Rust format)    │
├─────────────────────────────────────────────────────┤
│           Credit Vault Program (Pinocchio)           │
│   ┌──────────┬──────────┬──────────┬──────────┐     │
│   │ InitPool │ Approve  │ Draw     │ Repay    │     │
│   │          │ CreditLine│ Tranche  │ Tranche  │     │
│   ├──────────┼──────────┼──────────┼──────────┤     │
│   │ Post     │ Settle   │ Pause    │ Delegate │     │
│   │ Receipt  │ Maturity │ Line     │ (MagicBlk)│     │
│   └──────────┴──────────┴──────────┴──────────┘     │
├─────────────────────────────────────────────────────┤
│              Privacy Rails                           │
│   Umbra · Arcium · MagicBlock · Token-2022          │
├─────────────────────────────────────────────────────┤
│              Solana (Devnet)                         │
└─────────────────────────────────────────────────────┘
```

---

## Program Instructions

The on-chain program (`G4xPVrtUp4MkkEg5G5w5XCQskoraBBqimxFWh9NkpPm5`) is written in Rust using [Pinocchio](https://github.com/ancientFileManager/pinocchio) (zero-alloc BPF framework). It implements 10 instructions:

| # | Instruction | Description |
|---|------------|-------------|
| 0 | `InitializePool` | Creates a credit pool with admin, underwriter, auditor, note size, limits, and maturity |
| 1 | `ApproveCreditLine` | Underwriter authorizes a borrower with a note limit within pool capacity |
| 2 | `DrawTranche` | Borrower draws encrypted notes against their approved credit line |
| 3 | `RepayTranche` | Borrower repays outstanding notes with shielded settlement |
| 4 | `PostReceipt` | Auditor posts a receipt hash (commitment, not raw data) |
| 5 | `SettleMaturity` | Settles outstanding notes as defaulted after maturity passes |
| 6 | `PauseLine` | Underwriter pauses or reactivates a credit line |
| 7 | `DelegateCreditLine` | Delegates credit line state to MagicBlock edge runtime |
| 8 | `CommitCreditLine` | Commits delegated state back to mainnet |
| 9 | `CommitAndUndelegateCreditLine` | Commits and undelegates in a single instruction |

### State Accounts

- **Pool** (279 bytes) — Credit pool with admin, underwriter, auditor, note size, limits, drawn/repaid/defaulted counters, maturity slot, privacy policy
- **Credit Line** (278 bytes) — Borrower-specific line with limit, drawn/repaid/defaulted notes, terms hash, mandate hash
- **Receipt** (154 bytes) — Auditor-signed receipt with period slots, accepted slot, and receipt hash

### Security Model

- **Admin** creates pools and sets parameters
- **Underwriter** approves credit lines, pauses/reactivates lines
- **Auditor** posts receipts and verifies risk commitments
- **Borrower** draws and repays against their own lines
- Re-initialization protection on all accounts
- Overdraw protection (draws limited by line and pool capacity)
- Maturity enforcement (settlement only after maturity slot)

---

## Privacy Rails

| Rail | What It Hides | Implementation |
|------|---------------|----------------|
| **Variable-value notes** | Individual note amounts | Each note carries a different encrypted value |
| **Umbra settlement** | Payment destinations and amounts | Stealth addresses + AES-256-GCM envelopes |
| **Arcium risk compute** | Inventory, exposure, drawdown | x25519 encryption + commitment hashes |
| **MagicBlock ER** | Full execution state | Delegate to edge validator, commit back to mainnet |
| **Token-2022** | Transfer amounts | ConfidentialTransferAccount (pending ZK audit) |

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| On-chain program | Rust, Pinocchio (zero-alloc BPF) |
| Web frontend | Next.js 16, React 19, Tailwind CSS v4 |
| Wallet integration | Solana Wallet Adapter (Phantom, etc.) |
| Token operations | @solana/spl-token, @solana/web3.js v1 |
| Encryption | AES-256-GCM, x25519 key exchange |
| Edge runtime | MagicBlock SDK |
| Deployment | Vercel (frontend), Solana devnet (program) |

---

## Project Structure

```
├── programs/credit-vault/     # On-chain Rust program
│   └── src/
│       ├── lib.rs              # Entrypoint + unit tests
│       ├── processor.rs        # Instruction handlers + business logic
│       ├── instruction.rs      # Instruction serialization/deserialization
│       ├── state.rs            # Account layouts and serialization
│       └── mb.rs               # MagicBlock delegation helpers
├── apps/web-next/              # Next.js frontend
│   └── src/
│       ├── app/
│       │   ├── page.tsx        # Homepage (dashboard + interact)
│       │   └── trade/page.tsx  # Trading desk
│       ├── components/
│       │   ├── Dashboard.tsx   # Landing page with demo data
│       │   ├── RealApp.tsx     # Live devnet interaction (all tabs)
│       │   └── WalletProvider.tsx
│       └── lib/
│           ├── program.ts      # Instruction builders + account parsers
│           ├── risk-engine.ts   # MPC risk scoring simulation
│           ├── stealth-settlement.ts  # Umbra-style shielded envelopes
│           ├── magicblock.ts    # Edge runtime delegation
│           ├── token2022.ts     # Confidential transfer extension
│           ├── usdc.ts          # USDC deposit helpers
│           └── persistence.ts   # Local state persistence
├── apps/localnet/src/          # Integration tests
│   ├── local-integration.ts    # Full instruction flow test
│   ├── devnet-smoke.ts         # Devnet smoke test
│   └── surfpool-smoke.ts       # Surfpool local test
└── apps/api/src/               # Demo API endpoints
```

---

## Credit Flow

1. **Admin** initializes a pool with note size, credit limit, maturity, and privacy policy
2. **Underwriter** approves a credit line for a borrower (limit within pool capacity)
3. **Borrower** draws encrypted variable-value notes against their line
4. **Auditor** posts receipt hashes (commitments, not raw data)
5. **Borrower** repays notes with shielded settlement
6. After maturity, unsettled notes are marked as defaulted
7. Underwriter can pause/reactivate lines at any time

---

## License

MIT

# Mute — Demo Script (3-4 min Loom video)

## Setup Commands (run BEFORE recording)

```bash
# Terminal 1: Start the app
cd apps/web-next
bun run dev

# Terminal 2: Run all tests to verify everything works
cd /Users/singupallikartik/Developer/chat/confidential-market-maker-credit-network
bun test                              # 12 pass
cargo test --manifest-path programs/credit-vault/Cargo.toml  # 11 pass
bun run localnet:integration          # 8 pass (all instructions)

# Open browser to http://localhost:3000
# Make sure Phantom wallet is set to DEVNET
```

---

## Step-by-Step Demo

### [HOOK — 15 seconds]
**Say:** "What if you could get credit on Solana, but nobody — not even the blockchain — knows how much you actually borrowed? That's Mute. Let me show you."

**Show:** Homepage at http://localhost:3000

---

### [HOMEPAGE — 30 seconds]
**Say:** "Mute is a confidential credit protocol on Solana. Market makers get operating credit through variable-value notes. Each note has a DIFFERENT amount — so nobody can calculate your total exposure."

**Do:**
- Scroll down the homepage slowly
- Point at the privacy options section (shows Umbra, Arcium, MagicBlock)
- Point at the "DEVNET LIVE" badge in the nav bar

**Show:** The auto-play animation that shows the note lifecycle (apply → collateral → draw → risk → repay → verify)

---

### [PRIVACY TOGGLE — 15 seconds]
**Say:** "Public view shows only note count and status — just dots, no values. Toggle private view, and you can see the actual amounts."

**Do:**
- Find the "Show values / Hide values" toggle on the homepage
- Click it to toggle between encrypted (••••) and revealed ($ amounts)

---

### [SCROLL TO EXECUTE SECTION — 10 seconds]
**Say:** "Everything runs on Solana devnet. Real transactions, real on-chain state."

**Do:**
- Click "Execute" in the nav bar to jump to the interaction panel

---

### [CONNECT WALLET + AIRDROP — 15 seconds]
**Say:** "Connect Phantom — make sure it's set to devnet. Airdrop some free SOL for gas."

**Do:**
- Click the wallet connect button in the top right
- Select Phantom wallet
- Click "Airdrop 2 SOL" button
- Wait for confirmation in the log panel

---

### [INTERACT TAB — CREATE POOL — 20 seconds]
**Say:** "First, create a pool — this is the vault that holds the credit rules. We set note size and credit limit."

**Do:**
- You're on the "Core Actions" tab
- Note Size shows $1,000, Limit shows 50 notes
- Click "Create Pool"
- Wait for the tx confirmation
- Click the "Explorer →" link to show it on Solana Explorer
- Point at the pool state panel that appears on the right: "Pool: active"

---

### [APPROVE CREDIT LINE — 15 seconds]
**Say:** "Approve a credit line. The underwriter authorizes the borrower. Real transaction, confirmed on-chain."

**Do:**
- Click "Approve Credit Line" button
- Wait for confirmation
- Click Explorer link
- Point at the line state panel: "Credit Line: active"

---

### [DRAW CREDIT — 20 seconds]
**Say:** "Now draw credit. You enter the USD amount — $5,000 — and it converts to variable notes behind the scenes. Each note has a different encrypted value for privacy."

**Do:**
- Change the draw amount to 5000 (USD)
- See it shows "≈ 5 notes • Note values encrypted"
- Click "Draw $5,000"
- Wait for confirmation
- Click Explorer link

---

### [REPAY CREDIT — 10 seconds]
**Say:** "Repay some credit. Settlement is shielded — only commitment hashes go on-chain."

**Do:**
- Change repay amount to 3000
- Click "Repay $3,000"
- Wait for confirmation

---

### [TRADE PAGE — 30 seconds]
**Say:** "Now let me show you the trading desk — this is where market makers actually use their credit."

**Do:**
- Click "Trade" in the top nav bar (or go to http://localhost:3000/trade)
- Show the stats bar: Credit Limit, Credit Used, Open Positions
- Click "Positions" tab — shows the individual note positions with encrypted values
- Click "Reveal" to show the variable note amounts ($620, $780, $1,150, etc.)
- Click "Hide" to re-encrypt
- Click "History" tab — shows all transactions with Explorer links
- Click back to "Trade" tab

---

### [RISK TAB (homepage) — 15 seconds]
**Say:** "Back on the homepage — run the MPC risk check. Inventory and exposure go in, only a commitment hash comes out. The auditor never sees your raw numbers."

**Do:**
- Go back to http://localhost:3000
- Click "Risk Compute" tab
- Click "Run Risk Check"
- Show the result: score, commitment hash, proof
- Click "Verify Commitment"

---

### [SETTLEMENT TAB — 15 seconds]
**Say:** "Create a shielded settlement envelope. Uses Umbra-style stealth addresses with AES-256 encryption. Receipts are verified without decrypting."

**Do:**
- Click "Shielded Settlement" tab
- Click "Create Shielded Envelope"
- Show the envelope details: ID, commitment, receipt, ciphertext

---

### [MAGICBLOCK TAB — 15 seconds]
**Say:** "Delegate your credit line to MagicBlock's edge runtime for sub-millisecond private sessions. State commits back to mainnet."

**Do:**
- Click "MagicBlock ER" tab
- Show the ER config: RPC URL, validator, delegation PDA
- Optionally click "Delegate to ER" (only if you want to show this)

---

### [HISTORY TAB — 10 seconds]
**Say:** "Every transaction is recorded with direct Explorer links. Full transparency on what happened, privacy on the amounts."

**Do:**
- Click "History" tab
- Show the transaction list with types and slot numbers

---

### [CLOSE — 15 seconds]
**Say:** "Mute — confidential credit for Solana market makers. Variable notes, encrypted risk, shielded settlement. Live on devnet, open source. Thank you."

**Do:**
- Scroll back to top showing the homepage hero
- Show the "DEVNET LIVE" badge one more time

---

## Tab-by-Tab Reference

| Tab | What to Click | What to Show | What to Say |
|-----|--------------|-------------|-------------|
| Core Actions | Create Pool → Approve → Draw $5000 → Repay $3000 | Log panel + Explorer links + state panels | "Real on-chain transactions with encrypted note values" |
| USDC Deposits | Mint 10,000 Test USDC → Deposit | Token balance | "USDC collateral for credit lines" |
| Risk Compute | Run Risk Check → Verify Commitment | Score + commitment hash | "Auditor sees only a hash, never raw numbers" |
| Shielded Settlement | Create Shielded Envelope | Envelope ID + commitment + receipt | "Umbra-style stealth addresses" |
| MagicBlock ER | Delegate to ER | ER config + PDA | "Sub-millisecond private execution" |
| Token-2022 | (Read only) | Audit pending notice | "Ready when ZK audit completes" |
| History | (Auto-populated) | All txs with Explorer links | "Full transparency on actions, privacy on amounts" |
| **Trade Page** (/trade) | Setup Account → Draw → Repay | Positions table + encrypted values | "Trading desk for market makers" |

---

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Pool not found" | Pool was created on a different wallet/session. Clear state and create new pool |
| "Invalid account owner" | FIXED — account ordering was corrected |
| "Invalid instruction data" on Approve | FIXED — maturity slot now derived from pool's on-chain state |
| Wallet not connecting | Make sure Phantom is set to Devnet (Settings → Developer → Testnet Mode OFF, Devnet ON) |
| Airdrop fails | Devnet faucet is rate-limited. Wait 30s and try again |
| Transaction simulation failed | Check Phantom is on Devnet, not Mainnet |

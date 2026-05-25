# Surfpool Local Validation

Use Surfpool as the local validator for this project.

```bash
bun run program:test
bun run program:build-sbf
NO_DNA=1 surfpool start --network devnet --no-tui
```

In a second terminal, deploy to local Surfpool:

```bash
solana program deploy \
  --url http://127.0.0.1:8899 \
  programs/credit-vault/target/deploy/confidential_credit_vault.so
```

Then run the transaction smoke:

```bash
bun run localnet:smoke
```

The smoke reads transaction logs back from Surfpool and fails when a credit-vault instruction crosses its compute-unit ceiling. Current ceilings:

```txt
initializePool <= 1300 CU
approveCreditLine <= 1100 CU
drawTranche <= 950 CU
repayTranche <= 950 CU
postReceipt <= 850 CU
settleMaturity <= 900 CU
```

The current program is the accounting/control-plane vault. It validates pool state, borrower credit-line state, tranche draw/repay/default, receipt hashes, and pause controls. Token movement and live Umbra/Arcium/MagicBlock calls should be added after the settlement token and privacy provider are locked.

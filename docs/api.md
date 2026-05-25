# API

Local API:

```bash
PORT=8810 bun run apps/api/src/server.ts
```

## Routes

### `GET /`

Returns the local product demo page. It loads `/api/demo/proof`, `/api/demo/protocol`, and `/api/demo/credit-line`.

### `GET /health`

Returns service health.

### `GET /api/demo/credit-line`

Returns a demo credit line after draw, receipt posting, and partial repayment.

### `GET /api/demo/privacy`

Returns the public deal-room commitment and explicit Token-2022 confidential transfer status.

### `GET /api/demo/privacy-options`

Returns the privacy rail matrix: product rails, external settlement/compute rails, and native rails guarded by cluster support.

### `GET /api/demo/spend-line`

Returns a mock x402/pay.sh spend line with a paid API call receipt and the policy that keeps x402 out of core credit settlement.

### `GET /api/demo/maturity`

Returns the demo line after maturity settlement.

### `GET /api/demo/protocol`

Returns the Pinocchio program manifest: instruction names, account sizes, Surfpool command hints, privacy adapter routing, and x402 policy.

### `GET /api/demo/proof`

Returns the latest Surfpool deployment/smoke proof JSON when present, including program id, SBF hash, localnet signatures, final account snapshots, and compute-unit readings.

## Production Notes

Before production:

- replace mock x402 challenge with real payment challenge/facilitator verification;
- replace local development encryption secret handling with managed key storage, signer-scoped access control, and audit logs;
- keep Pinocchio account validation in front of any vault movement;
- add signer/wallet UX and transaction simulation for any on-chain action.

# Predict v2 keeper (settled-redeem + liquidation)

Permissionless keeper for the **new** Predict deployment (`predict-testnet-6-24`).
Two jobs, both callable by anyone (payouts go to position owners; the keeper only
pays gas):

1. **Settled redeem** — claims every in-the-money open order on settled markets via
   `expiry_market::redeem_settled` (no `Auth` — deterministic payout to the owner's
   account).
2. **Liquidation** — closes underwater leveraged orders via
   `expiry_market::liquidate_order`. Each candidate is **dry-run first**, so healthy
   orders cost no gas.

## Status: wired with live discovery (currently empty)

Markets, settlement state, and per-market orders all read from the beta indexer.
Order discovery uses `/markets/{id}/orders` (verified live 2026-06-27 — returns 200;
empty `[]` right now because there are no open orders on testnet). The global
`/orders`, `/market-orders`, `/managers` names 404, but per-market orders work.

Caveat: the order ROW field names in `server.mjs` → `normalizeOrder` are
best-effort (mapped without a populated sample). Confirm/adjust them the first time
a market has real open orders. The settled-redeem and liquidation flows, the tick
math, and submission are otherwise complete and dry-run-gated.

## Run

```bash
# from the app root (reuses the app's node_modules), dry-run / scan only:
DRY_RUN=true SUI_NETWORK=testnet node keeper/v2/index.mjs

# live (needs a funded SUI keeper key for gas):
KEEPER_SECRET_KEY=suiprivkey1... node --env-file=.env keeper/v2/index.mjs

# unit tests (pure detection logic):
node --test keeper/v2/scan.test.mjs
```

See `index.mjs` for all env vars. The legacy keeper (`keeper/src/`) is frozen and
serves the old deployment until its oracles wind down.

# skew_fee — Skew builder-fee router

A thin, trustless Move package that lets the Skew front-end charge a small builder
fee **on top of a bet**, enforced **on-chain**, in the **same atomic transaction**
as the mint. It composes DeepBook Predict — it does not fork or replace it.

```
mint_with_fee / mint_range_with_fee:
  1. read the real bet cost   → predict::get_trade_amounts
  2. carve fee_bps of cost    → transfer to treasury
  3. deposit the remainder    → caller's own PredictManager
  4. mint                     → predict::mint / mint_range
```

Everything runs as the **caller** (Predict's `mint`/`deposit` are sender-gated to
`manager.owner`), so there is no custody and no trust. The fee is computed from
the **chain-authoritative** cost, never a front-end number. Fee is taken at **mint
only** — redeem / close / withdraw are untouched.

> The base protocol's `predict::mint` is permissionless, so a user *could* mint
> directly and skip this router. The fee captures value from people using the Skew
> app — it is a front-end fee, not an unavoidable protocol tax. That's by design.

## Admin (capability pattern)

Publishing mints an **`AdminCap`** to the publisher and shares a **`FeeConfig {
fee_bps, treasury }`** (defaults: `fee_bps = 100` → **1.00%**, treasury = the
publisher). The cap holder retunes both with one cheap tx — no upgrade:

- `set_fee_bps(&AdminCap, &mut FeeConfig, bps)` — capped at **`MAX_FEE_BPS = 200`** (2.00%).
- `set_treasury(&AdminCap, &mut FeeConfig, addr)`.

Hand the `AdminCap` to a multisig later for shared control (it has `store`).

## Build

```bash
sui move build
```

## Publish (testnet)

The `predict-testnet-4-16` branch ships no `Published.toml` for `deepbook_predict`
/ `token`, so pin them first (idempotent), then publish:

```bash
./scripts/setup-published-deps.sh
sui client publish --skip-dependency-verification
```

From the publish output, record three ids:

- the **package id** → `config/predict.ts` `skewFeePackageId`
- the shared **`FeeConfig`** object id → `config/predict.ts` `feeConfigId`
- the **`AdminCap`** object id (lands in your wallet) → keep safe for admin calls

## Retune the fee / treasury

```bash
export SKEW_FEE_PKG=0x...        # package id
export SKEW_FEE_CONFIG=0x...     # FeeConfig id
export SKEW_FEE_ADMINCAP=0x...   # AdminCap id

./scripts/admin.sh show          # current fee_bps + treasury
./scripts/admin.sh fee 150       # set 1.50%
./scripts/admin.sh treasury 0x...# change payout address
```

## Front-end wiring

`config/predict.ts` carries `skewFeePackageId` + `feeConfigId` (testnet filled
after publish; mainnet TODO). When they're empty the app falls back to the plain
`predict::mint` flow (no fee), so the UI never breaks pre-deploy. The fee % shown
in the trade ticket is read live from `FeeConfig.fee_bps`.

## Roadmap

- Optional fee **floor/min** for dust-sized bets (skipped at launch for UX).
- A gated in-app admin page (currently CLI-only via `admin.sh`, by design — fewer
  attack surfaces).
- Mainnet publish + `config/predict.ts` mainnet ids.

# Predict Settled-Redeem Keeper

A standalone, unattended service that watches DeepBook **Predict** for **settled,
in-the-money, unclaimed** positions and calls `predict::redeem_permissionless` to
claim the payout **on behalf of the position owner** — the payout is deposited
into the owner's `PredictManager`, exactly as if they'd redeemed it themselves.

It's the infrastructure half of the terminal: the app lets *you* trade; the keeper
makes sure *everyone's* winnings get settled even if they never come back to claim.

## Why this matters

`redeem_permissionless` is callable by anyone once an oracle settles. On testnet
there are thousands of settled oracles and a long tail of unclaimed in-the-money
positions just sitting there. A keeper:

- gets owners their payouts without them lifting a finger,
- generates a steady stream of real on-chain transactions (great for a live demo),
- runs unattended — point it at the network and walk away.

> **On tips:** a keeper could in principle skim a tip from each payout, but on this
> branch `redeem_permissionless` deposits the full payout into the owner's manager
> and exposes no tip hook — so this keeper claims **nothing** for itself; it only
> spends SUI gas. Tipping would require protocol support.

## How it works

Each tick (`POLL_INTERVAL_MS`):

1. `GET /predicts/:id/oracles` → the set of **settled** oracles (+ settlement price).
2. `GET /positions/minted` → the managers that traded those settled oracles.
3. For each such manager, `GET /managers/:id/positions/summary` and keep the
   positions that are **settled + in-the-money + `open_quantity > 0`**
   (detected numerically: UP wins iff `settlement > strike`, DOWN iff `settlement ≤ strike` —
   verified to match the server's `redeemable` status).
4. For each candidate, build and submit
   `predict::redeem_permissionless<DUSDC>(predict, manager, oracle, market_key, qty, clock)`.

A per-candidate **cooldown** prevents resubmitting while the indexer catches up;
`MAX_REDEEMS_PER_TICK` bounds work per tick.

The candidate-detection logic ([`src/scan.mjs`](src/scan.mjs)) is pure and unit-tested
(`npm test`). The redeem PTB ([`src/redeem.mjs`](src/redeem.mjs)) mirrors the app's
proven `lib/sui/predict-tx.ts`.

## Run

```bash
cd keeper
npm install                 # or rely on the parent app's installed @mysten/sui
cp .env.example .env        # then edit

# Scan only — no key needed, never submits. Best first run:
npm run scan

# Live — submits redeem_permissionless (needs a funded keeper key + SUI for gas):
npm start
```

Get a keeper key + gas:

```bash
sui client new-address ed25519                       # create a keeper address
sui keytool export --key-identity <address>          # → suiprivkey1...  → KEEPER_SECRET_KEY
sui client faucet                                     # fund it with testnet SUI for gas
```

## Config (env)

| Var | Default | Meaning |
|---|---|---|
| `SUI_NETWORK` | `testnet` | `testnet` \| `mainnet` |
| `KEEPER_SECRET_KEY` | — | bech32 `suiprivkey1...` (or use `KEEPER_MNEMONIC`) |
| `DRY_RUN` | `true` | discover + simulate, never submit |
| `POLL_INTERVAL_MS` | `20000` | tick interval |
| `MAX_REDEEMS_PER_TICK` | `10` | submissions per tick |
| `MANAGER_SCAN_LIMIT` | `150` | managers inspected per tick |
| `MINTED_LIMIT` | `3000` | mint-event window scanned for active managers |
| `CONCURRENCY` | `8` | parallel server fetches |
| `COOLDOWN_MS` | `300000` | per-candidate resubmit cooldown |

## Mainnet

Fill the `MAINNET` block in [`src/config.mjs`](src/config.mjs) and set
`SUI_NETWORK=mainnet`. No code changes.

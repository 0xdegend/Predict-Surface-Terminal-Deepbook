# predict_hedge — atomic "PLP yield minus crash insurance" router

A thin, **trustless** Move package that composes DeepBook Predict into a single
call: open a hedged PLP position — earn the vault's house-edge yield while a cheap
out-of-the-money binary caps your crash risk — in **one atomic transaction**.

This is **phase 1** of the Hedge Vault (the service-free, no-operator version).
See [Roadmap](#roadmap) for the pooled tokenized-share upgrade.

## What it does

[`open_hedged`](sources/hedged_position.move) atomically:

1. **deposits** a hedge budget into the caller's own `PredictManager`,
2. **mints** an OTM hedge binary (the crash insurance) from that budget, and
3. **supplies** the remainder into the PLP vault, returning the `Coin<PLP>` shares.

Everything runs **as the caller** — `predict::mint` and `predict_manager::deposit`
are hard-gated to `ctx.sender() == manager.owner`, so there is no operator, no
custody, and no trust. The user signs, the user keeps the PLP and the hedge.

```move
public fun open_hedged<Quote>(
    predict: &mut Predict, manager: &mut PredictManager, oracle: &OracleSVI,
    hedge_expiry: u64, hedge_strike: u64, hedge_is_up: bool, hedge_quantity: u64,
    hedge_budget: Coin<Quote>, supply_coin: Coin<Quote>, clock: &Clock, ctx: &mut TxContext,
): Coin<PLP>

// entry wrapper that routes the PLP straight to the caller:
entry fun open_hedged_and_keep<Quote>(/* same args */)
```

The caller must already have a `PredictManager` (`predict::create_manager` is a
separate first-time tx). `hedge_budget` must cover the hedge `mint` cost; any
unspent remainder stays in the manager.

## Why phase 1 has no pooled share token

The protocol's `mint` is gated to the transaction sender (`ctx.sender() ==
manager.owner`) and `predict_manager::new` is `public(package)` — so an external
**pooled vault contract cannot mint hedges on behalf of depositors**. A pooled,
tokenized-share hedge vault therefore needs either an off-chain keeper (an
operator) or a capability-gated manager API the protocol does not yet expose.
Phase 1 sidesteps that entirely: per-user, atomic, trustless.

> Protocol feedback: a capability-based manager mint/deposit API would unlock
> fully on-chain composable vaults over Predict.

## Build & publish (testnet)

Requires the Sui CLI (`brew install sui`).

```bash
cd contracts/predict_hedge
sui move build                       # fetches deps + compiles
./scripts/setup-published-deps.sh    # ONE-TIME: see note below
sui client publish --skip-dependency-verification --gas-budget 200000000
```

Publishing costs only **free testnet gas** (fund your address at
https://faucet.sui.io). After publishing, copy the new package id into the
frontend config to wire up the "Open hedged position" flow.

### The `setup-published-deps.sh` note

The `predict-testnet-4-16` branch of `deepbookv3` ships a `Published.toml` for
`deepbook` but **not** for `deepbook_predict` / `token`. Without those, Sui treats
them as "unpublished dependencies" and refuses to publish. The script writes the
missing `Published.toml` files into the `~/.move` dependency cache, pinned to the
real deployed testnet addresses (read from the live package's linkage table):

| dep | testnet address |
|---|---|
| `deepbook_predict` | `0xf5ea2b37…5c785138` |
| `deepbook` | `0x74cd5657…f6cc77c8` (ships its own) |
| `token` (DEEP) | `0x36dbef86…57e0a58a8` |

It's idempotent and a no-op once upstream commits these (or registers in MVR).

Verified: `sui client publish --dry-run` → `execution status: success`.

## Roadmap

- **Phase 2 — pooled tokenized share.** A shared `Vault` that custodies pooled
  DUSDC + `Coin<PLP>` and issues a fungible `Coin<VAULT_SHARE>` (portable across
  Sui DeFi). Fully trustless for the PLP leg (`supply`/`withdraw` take coins
  directly, no manager).
- **Phase 3 — keeper hedge sleeve.** A bounded (≤5% NAV) keeper-operated OTM
  hedge overlay on the pooled vault, completing the "PLP yield minus crash
  insurance" product. Needs an operator because of the mint sender-gating above.

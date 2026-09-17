# Cutover runbook: predict-testnet-8-21 to 9-12

This one is not a choice. Mysten published a new testnet Predict on **2026-09-12** and
switched 8-21's oracle writers off on **2026-09-16**. Verified on chain on 2026-09-17: the
8-21 pyth feed had not advanced in seventeen hours and was frozen at $75,846.02, which is
the number the terminal was showing behind its "live prices delayed" chip. Staying put is a
dead terminal. Rolling back is a dead terminal. There is only forward.

Two consequences follow from that, and they are the whole reason this runbook reads
differently from the 8-21 one.

**The snapshot is not in a race.** 8-21 is frozen, so no trades land on it while we work.
The six-hour freshness gate still applies and still runs, but its urgency is gone.

**Money does not move forward.** 9-12 publishes its own collateral coin, so the usual
"sweep your old balance into the new account" path cannot work. See the section below.

---

## What changed under us

| | 8-21 | 9-12 |
|---|---|---|
| Collateral TYPE | `dusdc::DUSDC` | `usdc::USDC` (new package) |
| Collateral TICKER | DUSDC | **still DUSDC** |
| Cadences live | 1m 5m 1h 1d 1w | **1m 5m only** |
| HTTP indexers | three `-v4` hosts | none (NXDOMAIN) |
| Spot writer | Pyth | Pyth Lazer |
| Entry-function ABI | | **unchanged** |
| Order/market event structs | | unchanged plus additive fields |

The ticker is the one that saves work. Only the Move type was renamed: the on-chain
`coin_registry::Currency` still reads symbol `DUSDC`, and the upstream deploy README says
testnet "mints 100,000,000 test USDC with display symbol DUSDC". Every "DUSDC" in our copy
is correct and none of it is touched.

The ABI being unchanged is what makes this a config migration rather than a rewrite.
`abi-drift.live.test.ts` is green against 9-12: every function we build a transaction for
exists at the arity we build it, and every struct we decode positionally keeps its field
order.

---

## Before the day

**1. Register the builder code on 9-12. DONE 2026-09-17.**

A BuilderCode belongs to the registry that created it, and this registry is new, so 8-21's
code does not carry over. Without one the fee rail earns nothing and, worse, the new board
cannot tell a Skew trade from anyone else's, so the Skew leaderboard starts empty and stays
empty. Config deliberately does not fall back to the 8-21 id.

The founder registered it on 2026-09-17. Verified on chain: owner is the intended wallet and
the type prefix is 9-12's predict package.

```
NEXT_PUBLIC_BUILDER_CODE_ID_912=0x87dbf86e2915217eed2ef8c1abd25cf16d2236c659606f59f85d6da9ef6ba03f
```

Registration is **one way**. The signer becomes the code's permanent owner, there is no
reassignment, and losing that key forfeits every future fee. On mainnet, sign from a
multisig.

Two corrections worth keeping, because both cost real time here.

**The index is per deployment, not global.** An earlier draft of this step said index 0 was
"spent" on 8-21 and that the derivation collides across releases, and told you to use index
1. That is wrong. 8-06 and 8-21 both used index 0 from the same wallet. Index 0 aborted with
`EObjectAlreadyExists` on 9-12 only because the code had already been registered there
minutes earlier. Check what exists on the target registry before reading anything into an
abort. The id this draft predicted for index 1 was never created and is not ours.

**Put the id under the right key.** `BUILDER_CODE_ENV_VAR` in `config/predict.ts` maps each
deployment to its own env key. The 9-12 code was first pasted under
`NEXT_PUBLIC_BUILDER_CODE_ID_821` and nothing errored, because the id is a real, resolvable,
correctly typed BuilderCode that simply belongs to another registry. The 8-21 seed capture
then filtered 8-21's mints through a 9-12 code, found **0 Skew rows on both read paths**, and
burned twelve minutes before failing. The symptom to recognise is a board or capture
reporting 0 Skew rows while owner discovery still returns wallets, since those come from
`LEGACY_OWNERS` rather than from the code. `cutover-preflight.live.test.ts` asserts the
code's type prefix matches the deployment's predict package, and would have caught it.

There was no rush to get this in before the flip, for one specific reason: **nobody can trade
on 9-12 until we hold its collateral**, and as of 2026-09-17 nobody outside Mysten does. The
window in which a trade could go unattributed is empty. Do not rely on that indefinitely.

**2. Get funded with the new coin.**

The blocker for everything downstream. There is no public mint (the `usdc` package exposes
one private `usdc::init` and nothing else), no faucet contract, and no swap from the old
coin. The TreasuryCap is address-owned by Mysten's deployer, so this is an ask, not a task.

Ask for enough to cover the treasury float, not just a trading balance: the starter-grant
drip and the Founding Traders reward both hold the old coin and cannot onboard anyone until
we are funded.

---

## Cutover day

**3. Capture the final 8-21 board, with the app still pointed at 8-21.**

```
env RUN_LIVE=1 CAPTURE_SEED=1 NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 \
  "$(grep '^NEXT_PUBLIC_BUILDER_CODE_ID_821=' .env)" \
  npx vitest run lib/leaderboard/capture-seed.live.test.ts
```

Takes about fifteen minutes. It writes `lib/leaderboard/legacy-points-8-21.json` and
`lib/portfolio/legacy-history-8-21.json`, folding in whatever is already on disk for 8-21.
Leave the previous files in place; do not delete them first.

The capture fails rather than writing a partial board. A failure means do not proceed, not
retry until it passes.

**4. Register the new seed** in `lib/leaderboard/legacy-carryover.ts` (`ALL_SEEDS`) and
`lib/portfolio/legacy-history-data.ts`. One line each. The carryover guard excludes any seed
belonging to the deployment being read live, so the 8-21 seed switches itself on at cutover
and off on a rollback.

**5. Preflight against 9-12.**

```
NEXT_PUBLIC_PREDICT_DEPLOYMENT=9-12 RUN_LIVE=1 \
  npx vitest run lib/leaderboard/cutover-preflight.live.test.ts
```

Everything it checks is derived from the deployment the build points at, so this same gate
serves the next cutover too. It fails if the outgoing snapshot is stale, if a seed is
missing, if the builder code is absent or belongs to another package, or if a shared object
does not resolve.

**6. Full suite plus the live reads.**

```
NEXT_PUBLIC_PREDICT_DEPLOYMENT=9-12 npx vitest run
NEXT_PUBLIC_PREDICT_DEPLOYMENT=9-12 RUN_LIVE=1 npx vitest run lib/sui/v2/abi-drift.live.test.ts
NEXT_PUBLIC_PREDICT_DEPLOYMENT=9-12 RUN_LIVE=1 npx vitest run lib/api/v2/onchain-821.live.test.ts
NEXT_PUBLIC_PREDICT_DEPLOYMENT=9-12 RUN_LIVE=1 npx vitest run lib/api/v2/chart-history.live.test.ts
```

The third is the one that catches the silent failure: it proves stakes read as real numbers
rather than zeroes. The public GraphQL endpoint throttles under these bursts and occasionally
answers a 200 carrying "Failed to list events"; the pager retries that now, but a single red
run is worth repeating before treating it as a finding.

**7. Flip.**

```
NEXT_PUBLIC_PREDICT_DEPLOYMENT=9-12
```

Locally in `.env`, and in the two Vercel variables (`NEXT_PUBLIC_PREDICT_DEPLOYMENT` plus
`NEXT_PUBLIC_BUILDER_CODE_ID_912`). Deploy.

---

## After

- The leaderboard shows the carried standing, not an empty board.
- A returning trader's history tab is populated.
- The price chart draws its window and the live edge tracks the header tape, with no "live
  prices delayed" chip.
- Place one small real trade, confirm it lands, appears in positions, and attributes to the
  builder code. This needs step 2 first.
- Claim one settled position.

---

## Money stranded on 8-21

Say this plainly rather than offering a button that cannot work.

Every previous republish reused `dusdc::DUSDC`, so `buildLegacyMoveTx` could withdraw from
the old account and deposit into the new one inside a single PTB. 9-12 settles in a different
coin, so that transaction would hand a `Coin<DUSDC>` to `deposit_funds<USDC>` and the chain
would reject it — after the trader had been shown a banner, clicked it and approved a
signature. `canMoveFunds` now gates that, and `buildLegacyMoveTx` throws at build time rather
than failing on chain.

What remains possible is `buildLegacyWithdrawTx`: pull the old balance back to the wallet,
where it is still the trader's and still useless on 9-12. Offer that, and say why.

---

## What we are knowingly shipping without

**The ladder.** 9-12 enables only 1m and 5m; 1h, 1d, 1w and 1mo all ship disabled with tick
0. Founder decision on 2026-09-17 is to leave this alone, on the expectation that the long
cadences return once Mysten is happy with stability. Nothing is torn out: the day and week
code hangs off the cadence list in config, so it comes back on its own when the manifest
does.

Two knock-on effects while it lasts. Autopilot's day and week windows have nothing to trade,
and its two-minute expiry floor means it works the 5m markets rather than the 1m ones. Simple
mode still fills all three tabs, because its bands are time-to-expiry rather than cadence
labels, so a 5m market eight minutes out lands in the "1h" band exactly as an hourly one did.

**A faucet.** Until step 2 lands, the starter grant answers 503 "Treasury is low" rather than
dripping a coin the protocol has never heard of. That is deliberate: no faucet is honest, a
useless one is not. It starts working on its own once the treasury holds the new coin.

---

## Known issue, carried forward

`plp::request_supply` and `request_withdraw` gained a second `u64` parameter back in the 8-06
refresh, and our builders still pass one, so **vault deposit and withdraw abort**. This is
recorded in `abi-drift.live.test.ts`'s `KNOWN_BROKEN` list so it cannot go quiet. It is
deliberately unpatched: the added parameter is a bare `u64` whose meaning is not recoverable
from the ABI, and guessing a value on a path that moves a trader's money is exactly what that
tooling exists to prevent. Cutting over neither fixes nor worsens it.

# Cutover runbook: testnet 9-12 to MAINNET

Scanned and written 2026-09-24. Every on-chain claim below was verified live against
mainnet that day, not read off the manifest.

This is the first cutover where losing is real. Every previous runbook could afford to be
wrong for an hour. This one cannot.

---

## What mainnet actually is

DeepBook Predict is live on Sui mainnet. Manifest at
`packages/predict/deployment/deployment.mainnet.json` on `main`, schemaVersion 9,
sourceCommit `7b169bde2c2a`, chainId `35834a8a`.

**Verified live 2026-09-24:**

- Every shared object resolves, and their versions are in the billions and climbing
  (registry v1,016,825,277 against the manifest's recorded anchor of 952,358,392), so the
  protocol is being actively used, not merely published.
- Pyth Lazer had written **1.6 seconds** before the check. Block Scholes value store writes
  every 500ms. The two spot sources agreed to about two dollars ($84,076.00 vs $84,074.33).
- The registry is rolling fresh markets minute by minute, with live 1m and 5m expiries.

**It is the same protocol shape as 9-12.** A full structural diff of the two manifests
found **zero** differing keys and **zero** differing values in `initialConfiguration`:
identical units, pricing freshness windows, market template, and cadence ladder. So this
is a config swap and an operations project, not a protocol migration. No shape flag
(`V2_IS_729_PLUS` and friends) needs touching.

### The three things that genuinely differ

1. **The quote asset is real.** `0xdba34672…::usdc::USDC` is Circle's native USDC on Sui,
   6 decimals. The `symbol: 'USDC'` in the mainnet config is a statement of fact, not the
   deliberate divergence 9-12 carries. See [[predict-deployment-9-12]] for why testnet had
   to lie about its ticker.
2. **There are no HTTP indexers.** The manifest ships only `indexing.startCheckpoint`.
   **This is harmless.** Every `beta<>` read in `lib/api/v2/client.ts` sits behind
   `V2_IS_729_PLUS ? <on-chain> : beta(...)`, so the indexer path has been dead code since
   7-29. The only readers of `serverUrl` are a status `detail` string on page headers and
   the frozen v1 screen. Both are left empty deliberately.
3. **Only 1m and 5m cadences are enabled.** 1h, 1d, 1w and 1mo all ship `enabled: false`
   with tick 0, exactly as on 9-12. The Autopilot day/week ladder stays dormant on mainnet
   too, which matches the founder decision of 2026-09-17 to leave that ladder alone.

---

## Done already

- [x] **The gRPC endpoint pool is network-scoped.** `DEFAULT_FALLBACKS` is now a per-network
      record (testnet keeps its historical peer, mainnet ships none) and the four
      `new SuiGrpcClient({ network: 'testnet' })` call sites follow the active config.
      Testnet behaviour is unchanged.
- [x] **Carryover seeds are gated by network.** The guard lives in `carriedSnapshots`, so
      the points board and the portfolio history are covered by one rule with one test.
      Verified both ways: on testnet it carries 3 seeds / 979 traders / 784,863.55 points;
      on mainnet it carries nothing. `network` is now a field on `DeploymentSnapshot`
      (absent means testnet, since every seed we hold predates mainnet).
- [x] **The starter-grant ledger is network-scoped.** Found the hard way on mainnet's first
      day: 34 testnet grant wallets appeared on the freshly-empty Skew board, one
      participation point each, badged "Starter", on a chain where nobody had traded. The
      markers were correctly scoped by collateral coin, and a coin type is chain-specific,
      but `listFaucetClaimers` threw the scope away and enumerated the whole store. Same
      class of bug as the carryover seeds, in the one overlay that guard did not cover.
      `grantScope` now prefixes non-testnet networks (testnet keeps its exact historical
      spelling, so no existing wallet is silently re-offered a grant) and
      `listFaucetClaimers(network)` filters on it, with absent meaning testnet. Verified
      against the real store: testnet still reads 34, mainnet reads 0, and
      `/api/v2/leaderboard?fresh=1` returns an empty Skew board.
- [x] **The /v2/admin wallet is switched.** `adminAddresses` now defaults to
      `0x06a6f0f02ee7883cc37dfc0fd72834559cf008dde1cd7f2ee86e4a65688cfa48` instead of the
      old deployer key `0x33a8c3…f3f4`, replacing it rather than joining it (founder,
      2026-09-24). Verified on chain before the swap: funded and active on mainnet, zero
      balance and zero owned objects on testnet. The list is UI-only and **not network
      aware**, so testnet `/v2/admin` answers to the new wallet too. See the caveat under
      the fee rail for what the switch does not move.
- [x] **`V2_MAINNET` in `config/predict.ts` is filled** with the verified IDs. It is inert
      until `NEXT_PUBLIC_SUI_NETWORK=mainnet`, so this is safe to sit in the tree. It no
      longer spreads `...V2_TESTNET` (which was the stale 6-24 block) and is now a complete
      block modelled on 9-12.

---

## Code changes still required

### ~~1 and 2: gRPC network scoping~~ DONE 2026-09-24

### 3. Smaller

- `app/_components/flow-panel.tsx:61` hardcodes a testnet explorer URL. Legacy v1 screen, so
  low stakes, but it is the only explorer link in the app that does not follow
  `config.network`.
- `.env` sets `NEXT_PUBLIC_SESSIONS` twice (lines 51 and 75). Harmless today, confusing later.
- The **v1** `MAINNET` block in `config/predict.ts` still has `serverUrl: ''` and
  `coinType: ''` TODOs. Decide whether v1 ships to mainnet at all. Recommendation: it does
  not, and the legacy screen should be gated off rather than half-configured.

---

## The 9-12 seed — CAPTURED AND REGISTERED 2026-09-24

Done. `lib/leaderboard/legacy-points-9-12.json` and `lib/portfolio/legacy-history-9-12.json`
are captured, written and registered in `ALL_SEEDS` in both modules.

**What it holds:** 1 wallet, 11 trades, 6,328.05 points, +904.87 net PnL on the points
board; 3 wallets and 221 rows in the history seed. History covers more wallets than the
board because points are builder-code gated while session trades are fee-free and carry no
code, so a wallet can have a real trade history and no attributed points.

**The capture beat the live board**, which is the whole reason the tool exists: it found
**11 trades against the 4** the board was showing, because path A's global walk reaches
further back than the board's read window.

**It was captured twice, and the second run is the one on disk.** The first run's market
phase failed every settlement read (11 of 11 "would not answer"), which silently produced a
history of 9 rows that were **all wins** — settled losses have to be synthesized from
on-chain settlement, since nobody redeems a losing binary and there is no redeem event to
join against. The market objects were all still on chain and read fine when called
directly, so the failure was transient: the market phase fired straight after a
225-second, 979-owner fan-out and the endpoint had nothing left. The re-run read 94 of 94
markets cleanly and recovered the 2 missing losses. Final history: 221 rows across 3
wallets, with real wins AND losses.

> **Lesson for the next capture:** treat `N of N markets would not answer` as a FAILED
> capture, not a warning. An all-wins history is the visible symptom. Re-run before
> trusting the seed; the merge is idempotent (larger trade count wins per wallet) so a
> second pass can only improve it.

**Registering it now, rather than at cutover, is deliberate.** The 9-12 cutover shipped
with the 8-21 seed unregistered and the board silently lost 40% of its trades. Registered
today it is inert twice over: `carriedSnapshots` excludes a seed from the deployment being
read live, and the network guard excludes it from mainnet. Verified three ways after
registering, with the live board byte-identical before and after (999 rows, 786,183.16
points, 4,353 trades):

| context | seeds carried | traders | points |
| --- | --- | --- | --- |
| testnet, on 9-12 (today) | 6-24 + 8-06 + 8-21 | 979 | 784,863.55 |
| testnet, on another deployment | 6-24 + 8-06 + **9-12** | 870 | 524,836.25 |
| **mainnet** | **none** | **0** | **0** |

## Off-chain work, which is the long pole

None of this is code. All of it has to exist before a single real trade.

### The fee rail (nothing earns until this is done)

- [x] **BuilderCode registered on mainnet — DONE 2026-09-24.**
      `0x78b2d0b394f1ae956c97797b2488c5516ca6405fcf6ea0cc5079efa89d13907f`, index 0, owner
      `0x06a6f0…fa48`, shared. Verified on chain before wiring, all four checks that matter:
      the env var is `NEXT_PUBLIC_BUILDER_CODE_ID_MAINNET` (the one `V2_MAINNET` actually
      reads, which is what went wrong on 9-17); the type prefix is
      `0x89aea622…::builder_code::BuilderCode`, so it belongs to THIS registry; the internal
      `owner` is the switched admin wallet; and it resolves as a live shared object. Also
      hardcoded as the config default so a deploy that forgets the env var still earns, which
      is the failure that hit 8-06. `builderCodeEnabled` is now true on mainnet.
      Deliberately has no testnet fallback: a stale id attaches a code this registry never
      issued and mints silently earn nothing. See [[builder-code-every-deployment]].
- [ ] ~~**Publish `skew_fee_v2` on mainnet.**~~ **DEFERRED** by founder decision 2026-09-24:
      the Skew fee ships after the contract is deployed on mainnet, not before launch. It is
      already off and cannot accidentally charge, because `feeRouterV2Enabled` requires BOTH
      `NEXT_PUBLIC_SKEW_FEE_V2_PACKAGE_ID_MAINNET` and `..._CONFIG_ID_MAINNET`, and a fee
      cannot be taken through a package that does not exist. So mainnet earns the protocol's
      native builder fee only, which IS live. The note below is what has to be true to turn
      it on later: the package is framework-only, but it still has to exist on this chain and
      the FeeConfig is a per-object thing. **Publish from `0x06a6f0…fa48`**: `init` transfers
      the `AdminCap` to `ctx.sender()`, so signing from the new wallet makes it the fee admin
      by construction, with nothing to transfer afterwards.

      Verified 2026-09-24 that "off" is clean everywhere, not just unconfigured: the trade
      ticket hides both fee rows (`chargesSkewFee` false), the options net-payout maths reads
      the rate as 0, `addSkewFeeCharge` returns `0n` before touching the transaction, and the
      admin tab's own blurb now says it is not live on this network instead of asserting the
      fee is charged on-chain.

> **What the admin switch does NOT move, on testnet.** Neither the BuilderCode nor the fee
> `AdminCap` follows `adminAddresses`. The testnet BuilderCode `0x10aea977…` is owned by
> `0x33a8c3…` permanently, so testnet builder fees stay claimable only by the old wallet,
> and the testnet `skew_fee_v2` `AdminCap` `0x49787e25…` is still held by it, so the Skew
> fee panel reads but cannot sign from the new wallet. That cap is `key, store`, so a plain
> transfer fixes it whenever it is wanted. The new wallet also holds **zero testnet SUI**,
> so it cannot sign anything there until it is funded. None of this applies to mainnet,
> where neither object exists yet.

> **Founder decisions for the first mainnet launch (2026-09-24):** Enoki OFF, starter grant
> OFF, and every Walrus feature OFF (receipts, memory, chat history, Seal). All are opt-in
> `=== '1'` flags that default off, so this costs nothing but leaving them unset. Kelly's
> chat and Autopilot still run, since those need `ANTHROPIC_API_KEY` rather than Walrus;
> what goes dark is her memory between sessions and her public verifiable record.

### Identity and gas

- [ ] ~~**Enoki mainnet keys.**~~ DEFERRED. Launching Slush-only. `NEXT_PUBLIC_ENOKI_API_KEY` and `ENOKI_PRIVATE_API_KEY` are
      per-network. The Google OAuth client may also need a mainnet entry. `isEnokiNetwork`
      already accepts mainnet, so no code change.
- [ ] **Session gas treasury funded with real SUI**, with `SESSION_GAS_DRIP_ENABLED=1`. The
      drip now spends real money, so it needs a cap and a balance alarm.

### Walrus (Kelly receipts, memory, Seal) — DEFERRED for the first launch

Leave `NEXT_PUBLIC_KELLY_RECEIPTS`, `NEXT_PUBLIC_KELLY_MEMORY`, `NEXT_PUBLIC_KELLY_HISTORY`
and `NEXT_PUBLIC_KELLY_CHAT_SEAL` unset. The UI already handles it: the Record tab does not
render, the Autopilot "Verify" link only appears when a report blob exists, and receipt
minting is fire-and-forget behind the flag. Kept below because it is the list for whenever
Walrus does get turned on.


- [ ] **Mainnet writer wallet** funded with real SUI *and* real WAL. There is no public
      mainnet publisher, so writes must go through the relay with our own key.
- [ ] **MemWal account on the production relayer.** The testnet account will not work against
      it; `config/walrus.ts` already switches the URL but the account is separate.
      `WALRUS_MEMORY_ACCOUNT_ID` and `WALRUS_DELEGATE_KEY` need mainnet values.
- [ ] **Seal published on mainnet** with mainnet key servers. `NEXT_PUBLIC_SEAL_PACKAGE_ID`
      and `NEXT_PUBLIC_SEAL_KEY_SERVERS` are currently testnet.

> **Open bug carried in:** as of 2026-09-24 the *testnet* Walrus writer is out of WAL
> (0.00088 WAL against ~0.00134 needed per write), so `POST /api/kelly/receipts` returns 502
> and Kelly's calls are not being recorded. `writerHealth()` reports `ok` because it only
> measures SUI, so the dashboard shows green while every write fails. Fix the health check to
> read WAL as well before mainnet, or the same blind spot ships.

### Money

- [ ] ~~**Starter grant treasury.**~~ DEFERRED, `NEXT_PUBLIC_STARTER_GRANT_ENABLED=0`.
      Original note kept because it is what has to be true before it can ever be turned on: On mainnet this hands out real USDC. Two things must change:
      it needs a hard spend cap and monitoring, and it should stop being the founder's own
      trading wallet (see [[starter-grant]]). A compromised or drained trading wallet
      currently takes the faucet with it.
- [ ] **Decide the grant amount for real money.** The testnet number is meaningless here.

### Data that resets

- [ ] The **leaderboard and history KV are scoped per predict package**, so mainnet starts
      empty. That is correct and expected.
- [x] ~~**Do not register testnet carryover seeds on mainnet.**~~ DONE, and note there were
      TWO overlays, not one: the carryover seeds AND the starter-grant faucet participants.
      Only the first was gated on 2026-09-24; the second shipped to mainnet and had to be
      fixed live. If a third address-keyed overlay is ever added to the Skew board, gate it
      at the same time.
- [ ] ~~**Do not register testnet carryover seeds on mainnet.**~~ Every seed in
      `lib/leaderboard/legacy-carryover.ts` is testnet play money. `carriedSnapshots`
      excludes a seed whose deployment is active, but nothing stops a testnet seed appearing
      on a mainnet board. Gate seeds on network. See [[leaderboard-carryover]].
- [ ] `featuredWallets` is empty on mainnet by design. Opt in explicitly via
      `NEXT_PUBLIC_FEATURED_WALLETS_MAINNET`.

---

## Cutover day

1. Set `NEXT_PUBLIC_SUI_NETWORK=mainnet` plus every mainnet env var above.
2. Run the live checks against mainnet **before** announcing: `abi-drift`,
   `cutover-preflight`, `chart-history`. Two of the three bugs on the 9-12 cutover were
   exactly what these catch.
3. Dry-run the starter grant (`starter-grant-dryrun.live.test.ts` signs nothing).
4. Place **one** real trade with a small amount, end to end: deposit, mint, watch it settle,
   redeem. Confirm the builder code actually attached and the fee landed.
5. Only then open it up.

## Known cross-network KV, not yet scoped

Not urgent, because both features are OFF on mainnet for this launch, but they are the same
bug waiting to happen:

- `grant:daily:<utc-day>` and `sgas:daily:<utc-day>` are GLOBAL spend circuit breakers with
  no network segment. Once the starter grant or the session gas drip is enabled on mainnet,
  testnet payouts will eat the mainnet daily cap. Deliberately left alone rather than fixed
  in passing: changing the key resets a live spend counter, and that is a money-touching
  change nobody asked for.
- `reward:<campaign>:done:<addr>` (Founding Traders) has no network segment either, but the
  campaign name is an env knob (`NEXT_PUBLIC_REWARD_CAMPAIGN`), so a mainnet campaign under a
  new name is already separate. The feature is off by default.

Checked and already correct: `skew-iv:<predict package>` (IV history) and
`lb:idx:<predict package>` (the leaderboard tally) are both keyed by the predict package, so
they are network-correct for free.

## What we are knowingly shipping without

- **No leverage.** Removed from the protocol (#1236), so `noLeverageWindowMs: 0` is a
  ceiling on a feature that no longer exists. Quote everything at 1x. See
  [[no-leverage-on-mainnet]].
- **No 1h / 1d / 1w markets.** Protocol-side, not ours.
- **No faucet.** Real USDC. Funding a new trader is the starter grant's job.
- **No HTTP indexers.** Already dead code.

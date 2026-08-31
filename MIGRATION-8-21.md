# Cutover runbook: predict-testnet-8-06 to 8-21

Everything in this migration rolls back with one environment variable, except one thing.
The leaderboard snapshot is a moment in time, and trades that happen on 8-06 after it is
taken are carried nowhere. They are not lost on chain, they are simply not in the file we
bring forward, and nobody notices, because a board that is short a few hundred trades still
looks like a board.

That is why step 3 exists, and why it is deliberately placed as late as it can be.

Measured on 2026-08-31: Skew trades land at roughly **3 per hour**. A snapshot taken the day
before cutover quietly drops around seventy trades.

---

## Before the day (Phase 6)

**1. Register the builder code on 8-21.** DONE 2026-08-31.

Registered and verified on chain:

```
NEXT_PUBLIC_BUILDER_CODE_ID_821=0xdc76ac5bd92a9069c99296a8028dad00ca66ee439903b7626d8597b1b7992e7c
type   0x4210417542…::builder_code::BuilderCode   (the 8-21 package, not a carried-over code)
owner  0x33a8c34ae6…   index 0   shared
```

The rest of this step is kept for the next redeploy.

The builder code is per deployment. The 8-06 one belongs to a registry 8-21 has never heard
of, so config deliberately does not fall back to it. Without a code on 8-21 the fee rail
earns nothing and, worse, the new board cannot tell a Skew trade from anyone else's, so the
Skew leaderboard starts empty and stays empty.

Registration is **one way**. The signer becomes the code's permanent owner, there is no
reassignment, and losing that key forfeits every future fee. Sign from the wallet that
should own the revenue.

Dry-run it first. This simulates the real transaction from the address that will sign,
submits nothing, and prints the exact object id the real one will create:

```
REGISTER_SENDER=0x… NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 \
  npx vitest run lib/sui/v2/builder-code-register.live.test.ts
```

The call is `registry::create_and_share_builder_code(&Registry, &ProtocolConfig, u64 index)`,
byte for byte the same as on 8-06. It creates two objects: a **shared** `BuilderCode`, which
is the one to configure, and an entry owned by the registry, which is not. The ids are
derived from (sender, index) rather than from the transaction digest, so the dry run
predicts them exactly, and re-using an (owner, index) pair aborts.

For the current deployer `0x33a8c34a…` at index 0, the code will be
`0xdc76ac5bd92a9069c99296a8028dad00ca66ee439903b7626d8597b1b7992e7c`. Signing from any other
wallet gives a different id, so re-run the dry run if the signer changes.

Then set it in `.env` and confirm it matches what the transaction actually created:

```
NEXT_PUBLIC_BUILDER_CODE_ID_821=0x…
```

This can happen days ahead. It changes nothing for users while the app still points at 8-06.
The cutover preflight in step 4 checks the code exists on chain and belongs to the 8-21
package, so a wrong id here fails before the flip rather than after.

**2. Confirm the ABI has not moved since this work was done.**

```
NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 \
  npx vitest run lib/sui/v2/abi-drift.live.test.ts
```

If Mysten republishes 8-21 in place, this is what catches it. Re-run before cutover even if
it passed last week.

---

## Cutover day

Run these in order. Do not reorder steps 3 and 6.

**3. Re-run the leaderboard capture, with the app still pointed at 8-06.**

This is the step that must happen as late as possible. It reads the live 8-06 board and
overwrites both snapshot files. It must run against 8-06, using the 8-06 builder code, so
run it **before** the env var is flipped.

```
env RUN_LIVE=1 CAPTURE_SEED=1 "$(grep '^NEXT_PUBLIC_BUILDER_CODE_ID=' .env)" \
  npx vitest run lib/leaderboard/capture-seed.live.test.ts
```

Takes a few minutes. It writes:

- `lib/leaderboard/legacy-points-8-06.json`
- `lib/portfolio/legacy-history-8-06.json`

The capture has its own gates: it fails rather than writing a partial board if the fan-out
does not saturate, or if too many history rows cannot be priced. A failure here means do not
proceed, not retry until it passes.

**4. Run the preflight against 8-21.**

```
NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 \
  npx vitest run lib/leaderboard/cutover-preflight.live.test.ts
```

This is the gate that makes step 3 impossible to forget: it fails if the 8-06 snapshot is
more than six hours old, and the failure message contains the exact command to fix it. It
also checks that the builder code is registered on 8-21, that both retired boards are being
carried and the live one is not, that points and history are in step, and that every shared
object resolves.

Everything must be green before continuing.

**5. Run the full suite under 8-21.**

```
NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 npx vitest run
NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/api/v2/onchain-821.live.test.ts
NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/api/v2/chart-history.live.test.ts
```

The second proves the read layer returns real stakes and a fresh price rather than silent
zeroes. The third proves the chart still gets its three minutes of history.

**6. Flip the deployment.**

```
NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21
```

Deploy.

---

## After

**7. Verify against the running site.**

- The leaderboard shows the carried standing, not an empty board. Expect roughly **493
  traders** carried before anyone trades on 8-21, and it should only grow.
- A returning trader's history tab is populated.
- The price chart draws its full window and the live edge tracks the header price tape.
- Place one small real trade and confirm it lands, appears in positions, and attributes to
  the builder code.
- Claim one settled position, since `redeem_settled` changed shape on this release.

**8. Screenshot diff at 1400px and 390px.**

The exit gate for the whole migration is that nothing in the UI moved. Compare against
captures taken before the flip. Leverage controls should render their existing 1x
no-barrier state rather than disappearing.

---

## Rollback

Set `NEXT_PUBLIC_PREDICT_DEPLOYMENT` back to `8-06` and redeploy. Both deployments were
verified live and writing in parallel on 2026-08-31, so there is no forced cutover and
nothing expires.

The snapshot files are the only thing that does not roll back, and they do not need to: they
are a record of 8-06, they are still correct after a rollback, and the carryover guard turns
them off automatically when the app is reading 8-06 live.

---

## Known issue, unrelated to this migration

`plp::request_supply` and `request_withdraw` gained a second `u64` parameter back in the 8-06
refresh. Our builders still pass one, so **vault deposit and withdraw abort today**, on the
current production deployment, and they are wired to the UI.

This was found by `abi-drift.live.test.ts` and is recorded in its `KNOWN_BROKEN` list so it
cannot go quiet. It is deliberately unpatched: the added parameter is a bare `u64` whose
meaning is not recoverable from the ABI, and guessing a value on a path that moves a
trader's DUSDC is exactly what that tooling exists to prevent. It needs the Move source or
the official SDK to name it first.

Cutting over to 8-21 neither fixes nor worsens it.

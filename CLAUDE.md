# claude.md — Predict Surface Terminal

> A live 3-D volatility-surface trading terminal for **DeepBook Predict** on Sui.
> Sui Overflow 2026 · DeepBook track · build target branch `predict-testnet-4-16`.

You are building a production-grade frontend for an existing on-chain protocol. The protocol is already deployed on Sui Testnet — you are **not** writing Move. Your job is the client: a vol-surface visualizer that *is* the trading interface. Read this whole file before writing code. Verify the contract details flagged under **VERIFY FIRST** against source before you trust them.

---

## 0. The one-sentence pitch

The canonical Predict UI shows a flat list of markets. We render the **actual SVI volatility surface** the protocol prices against — strike × expiry × implied vol, live — and let a trader click any point on the surface to mint that exact binary or range. Surface viewer + one-click mint + live PnL + PLP risk = a professional terminal that no other team in this track will build, because the surface is the part everyone else is scared of.

---

## 1. Why this wins (the judging bar — internalize it)

2026 judging is explicitly skeptical of AI-built hollow UIs: a working demo plus **genuine Sui Stack usage in the live demo** is the *minimum*; template wrappers and unused SDK imports score nothing. The DeepBook track minimum requirement is literally: integrate the predict contract on testnet, and "work end to end if you are building a product — we will test the entire flow."

This design is engineered to clear that bar in ways that can't be faked:
- The mint/redeem/supply flow hits the real contract on testnet. Unfakeable.
- The surface consumes real `OracleSVIUpdated` events. Unfakeable.
- The whole thing is a product judges can drive end to end.
- It maps to **two** strong dimensions at once: technical execution (real options pricing + live on-chain integration) and UX (the surface interaction). Hackathon winners consistently score on at least two dimensions.
- Continuation story is built in: the protocol expects hackathon projects to **redeploy on mainnet day one**. Architect config so a mainnet swap is a single env change.

**Failure mode we are designing around:** a beautiful surface that doesn't trade (reads as analytics, not a product) OR a working trade flow with mispriced/wrong math (a quant judge spots it instantly). We avoid both — see §6.

---

## 2. Scope

**In scope (v1, the demo):**
1. **The Surface** — live 3-D SVI vol surface, time-travel scrub, arbitrage-free checker. Hero screen.
2. **Trade ticket** — click a surface node → mint a binary (up/down) or vertical range; live on-chain quote; one transaction.
3. **Positions panel** — the user's `PredictManager` positions + live PnL; redeem (incl. settled).
4. **PLP risk panel** (screen 2) — vault summary, utilization, withdrawal-limiter headroom, per-oracle exposure, ±Nσ "what-if" simulator.

**Explicitly out of scope for v1:** margin/`iron_bank` composability, cross-venue arbitrage bots, mobile-native trading (mobile = read-only surface), multi-quote-asset (DUSDC only).

**Stretch (only after 1–4 are solid):** embeddable surface widget; side-by-side vs an external smile; LP supply/withdraw UI.

---

## 3. Hard protocol facts (testnet, `predict-testnet-4-16`)

> ⚠️ These are **testnet** IDs pinned to the branch and **will change at mainnet**. Put every one of them in a single `config/predict.ts` keyed by network. Never hardcode inline.

| Thing | Value |
|---|---|
| Network | Sui **Testnet** |
| Public server base | `https://predict-server.testnet.mystenlabs.com` |
| Predict package | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138` |
| Predict registry | `0x43af14fed5480c20ff77e2263d5f794c35b9fab7e2212903127062f4fe2a6e64` |
| Predict object (shared) | `0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a` |
| Quote asset (DUSDC) | `0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC` |
| DUSDC currency ID | `0xf3000dff421833d4bb8ed58fac146d691a3aaba2785aa1989af65a7089ca3e9c` |
| DUSDC decimals | **6** |
| PLP coin type | `0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138::plp::PLP` |
| DUSDC faucet (form) | `https://tally.so/r/Xx102L` (this is NOT the standard testnet USDC — request it) |
| Source branch | `predict-testnet-4-16` of `MystenLabs/deepbookv3`, package at `packages/predict` |

**Internal scaling:** all protocol prices, strikes, forwards, and SVI params are scaled by `FLOAT_SCALING = 1e9`. DUSDC amounts use 6 decimals. Keep a single `scale.ts` with explicit `toFloat()` / `fromFloat()` and `toQuote()` / `fromQuote()` helpers. Mixing these up is the #1 source of silent bugs.

---

## 4. Data layer strategy (follow the protocol's own guidance)

Three sources, by freshness and purpose. Do **not** build the primary UI on raw chain scans.

1. **Public server** → page render, lists, portfolio, vault, history. Use **TanStack Query** with sane staleness.
2. **Live Sui events / checkpoints** → low-latency oracle tape (the surface needs this). Filter by the Predict **package ID** and watch the event types in §5.3. If checkpoint streaming is too heavy for v1, poll `/oracles/:id/svi/latest` and `/oracles/:id/prices/latest` at ~1 s as a fallback — but real event subscription scores better.
3. **Direct on-chain reads** → only around wallet flows that need authoritative state (quote preview via `devInspect`, post-tx confirmation reads).

### 4.1 Server endpoints (base = server URL above)

Protocol & market state:
- `GET /status`
- `GET /predicts/:predict_id/state`
- `GET /predicts/:predict_id/oracles`
- `GET /oracles/:oracle_id/state`
- `GET /predicts/:predict_id/quote-assets`
- `GET /oracles/:oracle_id/ask-bounds`

Vault & LP:
- `GET /predicts/:predict_id/vault/summary`
- `GET /predicts/:predict_id/vault/performance?range=ALL`
- `GET /lp/supplies` · `GET /lp/withdrawals`

Manager & portfolio:
- `GET /managers` · `GET /managers/:manager_id/summary`
- `GET /managers/:manager_id/positions/summary`
- `GET /managers/:manager_id/pnl?range=ALL`

History:
- `GET /oracles/:oracle_id/prices` · `/prices/latest`
- `GET /oracles/:oracle_id/svi` · `/svi/latest`   ← **drives the time-travel scrub**
- `GET /positions/minted` · `/positions/redeemed`
- `GET /ranges/minted` · `/ranges/redeemed`
- `GET /trades/:oracle_id`

> **VERIFY FIRST:** I have the routes but not the JSON field schemas. Phase 0 task: hit `/status`, `/predicts/<predict_object>/state`, `/predicts/<predict_object>/oracles`, and `/oracles/<id>/svi/latest` live, and generate TypeScript types from the real responses. Build to those types.

---

## 5. The contract API we call (module `deepbook_predict::predict`)

All confirmed from `predict.move` on `predict-testnet-4-16`. Signatures are Move; build them as PTB `moveCall`s with `@mysten/sui`'s `Transaction`.

### 5.1 Trading & LP entry points
```
create_manager(ctx): ID
get_trade_amounts(predict, oracle, key: MarketKey, quantity, clock): (mint_cost, redeem_payout)   // read-only, use via devInspect
ask_bounds(predict, oracle_id): (min, max)                                                          // read-only
mint<Quote>(predict, manager, oracle, key: MarketKey, quantity, clock, ctx)
redeem<Quote>(predict, manager, oracle, key: MarketKey, quantity, clock, ctx)
redeem_permissionless<Quote>(predict, manager, oracle, key: MarketKey, quantity, clock, ctx)         // only when oracle settled
get_range_trade_amounts(predict, oracle, key: RangeKey, quantity, clock): (mint_cost, redeem_payout) // read-only
mint_range<Quote>(predict, manager, oracle, key: RangeKey, quantity, clock, ctx)
redeem_range<Quote>(predict, manager, oracle, key: RangeKey, quantity, clock, ctx)
supply<Quote>(predict, coin: Coin<Quote>, clock, ctx): Coin<PLP>
withdraw<Quote>(predict, lp_coin: Coin<PLP>, clock, ctx): Coin<Quote>
available_withdrawal(predict, clock): u64                                                            // read-only
```
`Quote` = the DUSDC type. `clock` = `0x6`. `predict` = the Predict shared object. `oracle` = the chosen `OracleSVI` shared object.

Config reads (for the risk panel / pricing display): `trading_paused`, `base_spread`, `min_spread`, `utilization_multiplier`, `max_total_exposure_pct`, `accepted_quotes`.

### 5.2 Keys (positions are NOT standalone objects)
Positions live as quantities inside the `PredictManager`, keyed by:
- **MarketKey** = `(oracle_id, expiry, strike, is_up)`. `is_up` = pays when settlement is **above** strike.
- **RangeKey** = `(oracle_id, expiry, lower_strike, higher_strike)`. Pays $1·qty if settlement lands in `(lower, higher]`. Direction is not part of the key — bull-call and bear-put with the same strikes price identically.

> **VERIFY FIRST:** exact constructor functions and field accessors for `MarketKey` / `RangeKey` — read `packages/predict/sources/market_key.move` and `range_key.move`. Build a typed `keys.ts` wrapper around them.

### 5.3 Events to subscribe to (filter by package ID)
Oracle (from `oracle.move`):
- `oracle::OracleSVIUpdated { oracle_id, a, b, rho: I64, m: I64, sigma, timestamp }` ← **surface updates**
- `oracle::OraclePricesUpdated { oracle_id, spot, forward, timestamp }` ← **spot/forward tape (~1s)**
- `oracle::OracleSettled { oracle_id, expiry, settlement_price, timestamp }`
- `oracle::OracleActivated { oracle_id, expiry, timestamp }`

Predict (from `predict.move`): `PositionMinted`, `PositionRedeemed`, `RangeMinted`, `RangeRedeemed`, `Supplied`, `Withdrawn` (+ admin/config events). Use `PositionMinted`/`Redeemed` to animate fills on the surface and refresh the positions panel optimistically.

> Note: `rho` and `m` are **signed** (`i64::I64`). Parse the signed encoding correctly — getting the skew sign wrong tilts the whole smile the wrong way.

### 5.4 The mint PTB (the flow they will test)
A binary mint is a single transaction that may need to bootstrap manager + funding first:
1. If the user has no `PredictManager`: `create_manager()` (returns an ID; obtain it from tx effects / `/managers`).
2. Ensure the manager holds DUSDC: deposit DUSDC into the `PredictManager`. **VERIFY FIRST** the public deposit path — read `predict_manager.move` (the manager wraps a DeepBook `BalanceManager`; `mint` internally calls `manager.withdraw<Quote>(cost)`, so the manager must be pre-funded). Confirm the deposit entry function and whether it can be composed in the same PTB.
3. Build `MarketKey(oracle_id, expiry, strike, is_up)`.
4. `predict::mint<DUSDC>(predict, manager, oracle, key, quantity, 0x6, ctx)`.

Quote preview before submit: call `get_trade_amounts(predict, oracle, key, quantity, clock)` through `devInspectTransactionBlock` (read-only, no signature) to show exact `mint_cost`. This is authoritative — see §6.

---

## 6. The math spine (read this twice)

### 6.1 Hard rule: two different jobs, two different sources
- **Quoting a trade** (what the user pays / receives): always from the chain via `get_trade_amounts` / `get_range_trade_amounts` (devInspect). The contract applies a utilization- and inventory-dependent spread we will not perfectly replicate. Never show a client-computed price as the trade price.
- **Rendering the surface + no-arb checker**: client-side from the SVI params (the *fair* mid, no spread). This is for visualization and analytics only.

Keeping these separate is what makes us credible instead of "close enough."

### 6.2 SVI fair price (mirrors `oracle.move::compute_nd2`, for the surface only)
Given oracle `forward` and SVI `{a, b, rho, m, sigma}` (all 1e9-scaled → convert to floats first):
```
k        = ln(strike / forward)                                  // log-moneyness
w(k)     = a + b * ( rho*(k - m) + sqrt((k - m)^2 + sigma^2) )    // SVI total variance
d2       = -( (k + w/2) / sqrt(w) )
UP_fair  = N(d2)        // standard normal CDF
DN_fair  = 1 - UP_fair
range_fair(lo, hi) = UP_fair(lo) - UP_fair(hi)                   // ≥ 0 for lo < hi
```
Settled oracle: `UP_fair = 1` if `settlement_price > strike` else `0`.

### 6.3 The surface itself
- **Axes:** X = strike (or log-moneyness k), Y = time-to-expiry T, Z = **implied vol** `σ_IV(k) = sqrt(w(k) / T)`, with `T = (expiry_ms − now_ms) / MS_PER_YEAR`. (Plot IV, not raw variance — it's what traders read.)
- One oracle = one (underlying, expiry) = one smile curve across its strike grid. Stack oracles of the same underlying across expiries to form the surface.
- **Strike grid:** each oracle has a min strike + tick size + fixed tick count. **VERIFY FIRST** from `/oracles/:id/state` (or `oracle_config` / `add_oracle_grid` in source) so the rendered grid matches tradeable strikes exactly. Only render/clickable nodes that are actually mintable.

### 6.4 The arbitrage-free checker (make it real — it's the credibility flex)
- **Butterfly (within one expiry):** the contract guarantees UP price is **monotone non-increasing in strike**. Flag any adjacent pair where `UP_fair(strike_i) < UP_fair(strike_{i+1})` (price rising with strike) → butterfly violation. Equivalent check: `range_fair(lo, hi) < 0`.
- **Calendar (across expiries, same underlying):** total variance `w(k)` must be **non-decreasing in T** at fixed log-moneyness k. For expiries T1 < T2, sample a shared k-grid and flag any k where `w_{T2}(k) < w_{T1}(k)` → calendar violation.
- Render violations as highlighted cells/edges on the surface with a hover explanation. On live testnet data this should normally be clean; engineer a "stress" toggle that perturbs params so the checker visibly fires during the demo.

### 6.5 Tests (don't skip)
Build `lib/svi/` as a pure module with unit tests. Golden-value test: for a handful of (forward, SVI, strike, qty) tuples, assert the client `UP_fair`·qty is within tolerance of the chain's `get_trade_amounts` mid (after removing spread) via devInspect. If they diverge, the surface is lying — fix before building 3-D.

---

## 7. Tech stack (locked)

Non-negotiable core: **Next.js 16** (App Router) · **TypeScript** (strict mode) · **TailwindCSS** · **GSAP** · **React Three Fiber** (+ `@react-three/drei`). Package manager: npm.

**Next.js 16 / RSC architecture — get the boundaries right (this is where junior builds fall apart):**
- R3F, GSAP, `@mysten/dapp-kit`, wallet state, and the event subscription are **client-only**. Isolate them behind `'use client'` leaf components. Keep layouts, the terminal shell, and any server-fetchable snapshot as Server Components.
- The surface canvas is heavy — mount it via `next/dynamic` with `{ ssr: false }` behind a designed skeleton, so the shell paints instantly and Three.js hydrates after. Never block first paint on the canvas.
- Server Components fetch the initial server-API snapshots (market list, oracle list, vault summary) so the terminal renders *with data* before the client live-tape attaches. Hydrate TanStack Query from that.
- Build with Turbopack. Mount `<Canvas>` exactly once and drive it via state/refs — never remount per update. One render loop, period.

Supporting libs:
- **Sui:** `@mysten/dapp-kit` (wallet + query client provider) + `@mysten/sui` (`Transaction`, `SuiClient`, `devInspectTransactionBlock`, event subscription). Wallet target: **Slush**.
- **3-D:** R3F + drei. Surface = a single parametric mesh (`BufferGeometry`, per-vertex color ramp by IV), raycaster for node selection. A custom shader material for the IV ramp + rim glow if time allows.
- **Motion:** **GSAP** — register a `gsap.context()` per component for clean teardown. Drives the time-travel scrub timeline, page-load choreography, transitions, and fills. Keep it separate from the R3F loop: GSAP animates DOM/values, R3F reads them.
- **2-D charts:** lightweight-charts (preferred for the financial panels) or visx for PnL, vault performance, and the per-strike inventory heatmap. Tabular figures everywhere.
- **Data:** TanStack Query for the server API; a thin client hook for the live event tape.
- **State:** Zustand for shared selection (underlying / expiry / strike / direction / qty) bridging the surface ↔ trade ticket.

Use `config/predict.ts` (network-keyed) and `config/scale.ts` everywhere. A mainnet cutover must be one env switch.

---

## 8. Screen spec

### 8.1 The Surface (hero, desktop-first)
- Full-bleed 3-D SVI surface, live. Color ramp = IV. Subtle grid floor, axis ticks (strike, expiry, IV).
- **Underlying selector** (BTC etc.) and **expiry rail** — selecting narrows/zooms.
- **Time-travel slider** (GSAP-driven): scrub `/oracles/:id/svi` history; the surface morphs between snapshots; "LIVE" snaps to the event stream.
- **No-arb overlay** toggle: highlights butterfly/calendar violations; "stress" toggle for the demo.
- **Hover** a node → tooltip (strike, expiry, IV, fair UP/DN). **Click** → opens the trade ticket pre-filled.
- Live spot/forward readout updating from `OraclePricesUpdated`.

### 8.2 Trade ticket (slide-over)
- Pre-filled (oracle, expiry, strike, direction) or range (lower/higher). Toggle UP/DOWN; switch to range mode (pick two strikes off the surface).
- Quantity input → live preview via `get_trade_amounts` devInspect: ask price, total cost (DUSDC), max payout, breakeven, current ask-bounds.
- One **Mint** button → builds the §5.4 PTB (bootstrapping manager + deposit if needed). Optimistic fill animation on the surface; toast with explorer link.

### 8.3 Positions / PredictManager panel
- From `/managers/:id/positions/summary` + `/managers/:id/pnl`. Live PnL marked off current fair value.
- Per position: oracle/expiry/strike/direction, qty, entry cost, current value, PnL. **Redeem** (`redeem` / `redeem_range`; `redeem_permissionless` once `OracleSettled`).
- Empty state guides the first trade.

### 8.4 PLP risk panel (screen 2)
- Vault summary + `/vault/performance` chart; utilization vs `max_total_exposure_pct`; withdrawal-limiter headroom via `available_withdrawal`.
- Per-oracle exposure breakdown; per-strike inventory heatmap.
- **±Nσ what-if simulator:** shock spot by N standard deviations, recompute vault MTM client-side with the §6 SVI math, show projected PLP PnL. Historical drawdown replay over `/vault/performance`.
- Framing line: this answers "is PLP safe?" — the question that gates LP capital.

---

## 9. Build phases (de-risk in THIS order — do not reorder)

- **Phase 0 — Plumbing.** Next app, `config/predict.ts`, wallet connect (Slush via dapp-kit), request DUSDC from the form. Hit `/status`, `/state`, `/oracles`, `/svi/latest`; generate types from real responses. Prove we can read live protocol data.
- **Phase 1 — The flow, UGLY.** Before any 3-D: `create_manager` → deposit DUSDC → `mint` a binary → see it via `/managers/:id/positions/summary` → `redeem`. One full round trip on testnet from a plain button. **This is the make-or-break; if it doesn't work, nothing else matters.**
- **Phase 2 — The math.** `lib/svi/` + tests; golden-value check vs chain. Render a static smile, then the full static surface from latest SVI.
- **Phase 3 — Live + interactive.** Event subscription → live surface; time-travel scrub; no-arb checker + stress toggle.
- **Phase 4 — Fuse.** Click surface → trade ticket → mint (Phase 1 flow, now wired to the surface). Live positions panel.
- **Phase 5 — Risk panel.** Vault data + what-if simulator.
- **Phase 6 — Polish.** Design pass (§10), GSAP choreography, loading/empty/error states everywhere, mobile = read-only surface, demo script + seeded walkthrough.

A judge will run Phase 1's flow. A judge will be wowed by Phases 3–4. Protect both.

---

## 10. Design direction — build a terminal, not a page

You are a senior frontend engineer shipping a professional trading instrument. The bar is "a quant would abandon their current tool for this," not "a nice landing page." Two hard bans, then the system.

### 10.1 Two things this must NOT be
- **NOT generic AI UI.** No Inter / Roboto / system-font defaults. No purple-on-white gradients. No centered hero + three feature cards. No rounded-everything, no unstyled shadcn left at defaults, no Bootstrap-y component soup. If it looks like every other AI dashboard, it has failed.
- **NOT editorial / newspaper.** No serif display headlines, no magazine columns, no drop caps, no ALL-CAPS kickers or bylines, no ruled-line dividers or marker-highlight as decoration, no justified prose blocks. This is an instrument panel, not an article. The chrome is functional, never typographic.

### 10.2 The aesthetic: refined dark "engineered minimalism"
Bloomberg-terminal density × Linear/Vercel restraint × Phantom-grade polish on the 3-D. The surface is the only element that *glows*; everything else is quiet, precise scaffolding around it. Dark is correct here — do not reuse any light-mode palette from prior work.

### 10.3 Design tokens (define once — CSS variables + Tailwind theme)
- **Surfaces:** never pure black and never pure-white text. Base ≈ `#0A0B0D`. Build elevation from 3–4 near-black steps separated by **1px hairline borders** (`rgba(255,255,255,0.06–0.10)`), NOT drop shadows. The only real shadow/glow in the app is the surface canvas.
- **Text:** three steps only — primary (~`#E6E8EB`), secondary (muted), tertiary (dim, for labels).
- **Accent:** exactly one functional ramp — the **IV color ramp** (cool→warm) which lives on the surface and nowhere else competes with it. Up/Down get two desaturated semantic colors (a teal-green, a coral-red); PnL reuses them. That is the entire palette. No third accent color.
- **Radius:** small and consistent (4–8px). Nothing pill-shaped by default.
- **Spacing:** strict 4/8px scale. Density is a feature inside panels; generous air is a feature around the surface.

### 10.4 Type system
- **Numbers / data → a characterful monospace with true tabular figures** (Geist Mono, Berkeley Mono, JetBrains Mono, or Commit Mono). Every price, strike, IV, PnL, and address. Tabular numerals are mandatory so columns don't jitter on tick.
- **UI / labels → a clean, slightly characterful grotesque** (Geist, or a Söhne/Suisse-like face). Avoid Inter/Roboto; do not default to Space Grotesk. Pick one and commit.
- Deliberate, tight sizing: small chrome labels (11–13px), larger only for the few hero numbers (live spot, selected IV). Letter-spacing on micro-labels only.

### 10.5 Layout architecture
- Persistent terminal chrome: a thin top bar (network/status pill, underlying selector, wallet, live spot tape), the surface owning the canvas center, and a docked right rail (trade ticket / positions). Screen two (PLP risk) slides over or routes, sharing the same chrome.
- **Grid-driven, not flow-driven.** Panels are framed regions delimited by hairline borders — not floating cards on a scrolling page. Think cockpit, not feed.
- Hierarchy comes from weight, alignment, and position — never from decorative rules or boxes.

### 10.6 Motion (GSAP) — high-impact moments only
- **One orchestrated load:** chrome paints → surface assembles (vertices rise / mesh fades up) → axes draw in → live tape starts, with tasteful stagger. This single sequence is the first impression; make it intentional.
- **The signature: the time-travel scrub.** The surface morphs smoothly between SVI snapshots as the user drags; "LIVE" snaps back to the stream. This has to be buttery — it's the interaction judges replay.
- **Fills ripple** across the surface on `PositionMinted`. Node selection = a precise, fast highlight, never a bounce.
- Everything else holds still. No scattered hover wiggles. Honor `prefers-reduced-motion`.

### 10.7 The details a senior engineer ships (non-negotiable)
- **Every state designed:** loading (skeletons that match the final layout — no spinners on blank), empty (guides the first action), error (legible, recoverable), and **optimistic** (a mint shows pending on the surface before confirmation). Handle the live tape "catching up" partial state.
- **Zero layout shift** on data tick (reserve widths; tabular figures).
- **Number formatting is one shared util:** fixed precision per field, thin-space thousands, signed and colored PnL, truncated addresses with copy.
- **Pixel-snapped 1px borders**, crisp on HiDPI. Consistent `focus-visible` rings. Fully keyboard-navigable trade ticket. AA contrast for all text on its surface.
- **3-D performance budget:** hold 60fps on a laptop. Cap surface tessellation sensibly, throttle live updates to animation frames, dispose geometries/materials on unmount, zero per-frame allocations in the render loop.

### 10.8 The unforgettable thing
A trader drags the time-travel slider and watches the *actual* volatility surface the protocol prices against breathe through the last hour, sees a butterfly violation flare red, then clicks a ridge of the live surface and mints it — all in one fluid instrument. That sentence is the demo. Build toward it.

Load the **frontend-design** skill before the polish pass.

---

## 11. Skills & references to load in Claude Code

**Load these Sui skills first** (installed globally — see `https://docs.sui.io/skills`): the Sui / Move / dapp-kit / PTB skills. They carry environment-correct patterns for wallet flows, `Transaction` building, `devInspect`, and event subscription. Prefer their guidance over guesswork.

Source to read directly (branch `predict-testnet-4-16`, repo `MystenLabs/deepbookv3`, path `packages/predict/sources/`):
- `predict.move` — entry points (confirmed in §5).
- `oracle.move` — SVI struct, events, `compute_nd2` (confirmed in §6).
- `market_key.move`, `range_key.move` — **VERIFY** key constructors (§5.2).
- `predict_manager.move` — **VERIFY** deposit/withdraw + manager creation/funding (§5.4).
- `vault.move` — vault value, MTM, max payout, exposure (for §8.4).

Docs: DeepBook Predict overview / design / contract-information at `docs.sui.io/onchain-finance/deepbook-predict/`. DeepBook v3 + margin docs are **optional** (only if we later add composability — out of scope for v1). DeepBook **sandbox** (`MystenLabs/deepbook-sandbox`) is optional for a local stack if testnet is flaky.

SDK references: `@mysten/dapp-kit` and `@mysten/sui` docs for wallet, `Transaction`, `devInspectTransactionBlock`, and `client.subscribeEvent` / checkpoint reads.

---

## 12. VERIFY FIRST — confirm before trusting this brief
1. Server JSON field schemas (§4.1) — generate types from live responses.
2. `MarketKey` / `RangeKey` constructors and accessors (§5.2).
3. `PredictManager` deposit path and whether create+fund+mint can share one PTB (§5.4).
4. How to obtain the new `PredictManager` ID client-side after `create_manager` (tx effects vs `/managers`).
5. Per-oracle strike grid (min strike, tick size, tick count) (§6.3).
6. Signed encoding of `rho` / `m` in the `OracleSVIUpdated` event (§5.3).

If anything here conflicts with source, **source wins** — and tell me so I can update the brief.

---

## 13. Definition of done (maps to the judging criteria)
- [ ] **Genuine Sui-stack usage:** real `mint` / `redeem` PTBs land on testnet; surface driven by real `OracleSVIUpdated`. (Anti-hollow-UI bar.)
- [ ] **End-to-end (their test):** create manager → deposit → mint → position appears → redeem, all from the UI.
- [ ] **Quotes are chain-authoritative** (devInspect), surface math is tested against chain.
- [ ] **The signature:** clicking the live surface mints that strike/expiry.
- [ ] **No-arb checker** demonstrably fires (stress toggle).
- [ ] **PLP risk panel** with a working ±Nσ simulation.
- [ ] **Mainnet-ready:** one env switch flips all IDs (continuation story).
- [ ] **Demo:** a 90-second scripted walkthrough that survives a judge driving it themselves.

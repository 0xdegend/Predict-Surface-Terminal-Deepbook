# Predict Surface Terminal — 90-second demo script

> Live 3-D SVI volatility-surface trading terminal for **DeepBook Predict** on Sui Testnet.
> A judge can drive every step themselves. Everything hits the real contract / real data.

## Before you start
- `npm run dev` → open the printed URL (usually http://localhost:3000, or :3001 if taken).
- Connect a **Slush** wallet (top-right). Testnet.
- Get DUSDC: the trade ticket shows a **"get DUSDC"** link when your balance is low
  (the Tally faucet form — this is *not* the standard testnet USDC).
- A little testnet SUI for gas.

## The walkthrough

**1. The surface (0:00–0:20)**
- The hero is the **live SVI volatility surface** the protocol actually prices against:
  X = log-moneyness, depth = time-to-expiry, height + color = implied vol.
- It **breathes** — it morphs as new `OracleSVIUpdated` / price data arrives (~2s).
- The live BTC spot/forward tape ticks in the top chrome.

**2. Time-travel (0:20–0:35)**
- Drag the **scrub** slider under the surface — the whole surface morphs through the
  last few minutes of SVI history. Hit **LIVE** to snap smoothly back to the stream.

**3. No-arb checker (0:35–0:50)**
- Toggle **no-arb** — clean surface reads `no-arb ✓`.
- Toggle **stress** — the perturbed smile violates Lee's moment bound; butterfly/calendar
  cells **flare red**. This is a real arbitrage-free check, not decoration.

**4. Click-to-trade — the signature (0:50–1:15)**
- **Hover** any node → tooltip with strike, IV, fair UP/DN, expiry.
- **Click** a ridge → the trade ticket pre-fills that exact strike + expiry ("↑ from surface").
- The **quote is chain-authoritative** (`get_trade_amounts` via simulate) — cost, payout,
  per-unit ask.
- First time: **Create manager** → **Mint UP/DOWN**. The mint deposits DUSDC + mints in one
  PTB. A **fill ripple** flares on the surface; the position appears below with live PnL.
- **Redeem** the position; **withdraw** DUSDC back to the wallet. Full round trip on testnet.

**5. PLP risk (1:15–1:30)**
- Top nav → **PLP Risk**. Real vault: value, liability (MTM), utilization vs the on-chain
  exposure cap, withdrawal headroom, PLP share-price history.
- The **±Nσ what-if**: vault liability repriced off the live SVI surface using real net
  open interest, under a spot shock. Drag the σ slider → projected PLP P&L. Verdict line
  answers the LP's question: **is PLP safe?**

## Why it can't be faked
- `mint` / `redeem` / `withdraw` are real PTBs landing on testnet.
- The surface consumes real oracle SVI/price data.
- Quotes come from the chain; the client surface math is **golden-tested** against the
  chain to ~1e-4 (`RUN_GOLDEN=1 npx vitest run lib/svi/golden.live.test.ts`).
- One env switch (`NEXT_PUBLIC_SUI_NETWORK`) flips every ID for mainnet day one.

## Commands
- `npm run dev` — terminal (Turbopack)
- `npm test` — 20 unit tests (SVI math, no-arb, what-if)
- `npm run build` — production build

/**
 * lib/insights/engine.ts — the shared market-intelligence engine.
 *
 * ONE server-callable entry point, `buildMarketIntel`, that composes the pure
 * generators — probability, expected move, volatility regime, no-arb, the
 * plain-language read, and the directional recommendation — into a single
 * `MarketIntel` snapshot. Every surface that shows numbers reads them from here:
 * the co-pilot, the BTC Options page, and later the X bot. They can't disagree,
 * because they all bottom out on the same `lib/svi` + `lib/insights` primitives —
 * there is exactly one implementation of each figure (enforced by the cross-check
 * tests in engine.test.ts, which pin the engine's verdicts to the co-pilot's).
 *
 * PURE + SERVER-SAFE (CLAUDE.md §6.5): no React, no fetch, no browser globals — a
 * Next route handler or a scheduled bot job can `import` and call it directly.
 *
 * Asset-parametrized: every snapshot is keyed to an {@link AssetConfig}, so BTC
 * today and ETH / RWA later is a config choice, not a rewrite.
 */
import { upFair, dnFair, totalVariance, impliedVol, timeToExpiryYears, type SviFloat } from '@/lib/svi/svi';
import { buildSurface, type SmileInput } from '@/lib/svi/surface';
import type { AssetConfig } from './assets';
import type { MarketContext } from './context';
import { buildMarketRead, recommendation, type MarketRead } from './market-read';
import { analyzeStrike, type StrikeAnalysis } from './strike-analysis';
import { expectedMove, type ExpectedMove } from './expected-move';

/** A minimal on-chain pricer: the live forward + SVI a market prices against.
 *  Structurally a subset of `LivePricer`, so callers can pass a `LivePricer`. */
export interface EnginePricer {
  forward: number;
  svi: SviFloat;
}

/** A live, priceable expiry: its id, when it settles, and its pricer. Deliberately
 *  leaner than the co-pilot's `BetCandidate` so the engine stays free of any
 *  client / copilot coupling; the Options page maps its v2 markets to this. */
export interface EngineCandidate {
  marketId: string;
  expiryMs: number;
  pricer: EnginePricer;
}

/** How the near-term implied swing compares to the asset's recent realized move. */
export type VolState = 'calm' | 'normal' | 'elevated';
/** Whether the live surface is arbitrage-clean or has a fleeting mispricing. */
export type ArbState = 'clean' | 'watch';
/** The blended off-chain directional lean from the context (never a probability). */
export type Bias = NonNullable<ReturnType<typeof recommendation>>;

/** One tradeable expiry as the page/cockpit reads it. */
export interface MarketExpiry {
  marketId: string;
  expiryMs: number;
  /** Chance the asset finishes ABOVE its current price, from the live surface (0..1). */
  upChance: number;
  /** At-the-money implied vol for this expiry (annualized fraction). */
  iv: number;
  /** Which way the surface tilts (upChance ≥ 0.5). */
  isUp: boolean;
}

/** The unified snapshot every surface renders from. */
export interface MarketIntel {
  asset: AssetConfig;
  /** When the snapshot was taken (ms epoch). */
  asOf: number;
  /** Live price ($) — the spot feed, falling back to the context's spot. */
  spot: number | null;
  /** Soonest still-open expiry, or null. */
  nextExpiryMs: number | null;
  /** Every still-open expiry, soonest first. */
  expiries: MarketExpiry[];
  /** The front expiry's ±1σ expected-move band. */
  expectedMove: ExpectedMove | null;
  /** Near-term implied vs recent realized regime (null until candles load). */
  vol: VolState | null;
  /** No-arb verdict across the surface (null with < 2 expiries or no smile inputs). */
  arb: ArbState | null;
  /** The soft off-chain directional lean, or null with no context. */
  bias: Bias | null;
  /** The plain-language market read (no-bet form), or null with no context. */
  read: MarketRead | null;
}

export interface MarketIntelInput {
  asset: AssetConfig;
  /** Reference clock (ms epoch) — pass the price feed's timestamp, not Date.now(),
   *  so a render never trips the react-hooks/purity lint (CLAUDE.md). */
  now: number;
  /** Live price ($). */
  spot: number | null;
  /** Off-chain market context (Clawby), or null when unavailable. */
  ctx: MarketContext | null;
  /** The live, priceable expiries. */
  candidates: EngineCandidate[];
  /** Recent 1-minute closes (oldest → newest), for the vol regime. Optional. */
  closes?: number[] | null;
  /** Per-expiry smile inputs, for the no-arb checker. Optional. */
  surfaceInputs?: SmileInput[] | null;
}

/** Minutes of 1-minute bars used to scale the realized sigma window. */
const clampMinutes = (m: number) => Math.max(1, Math.round(m));

/** Still-open expiries, soonest first. `minRunwayMs` drops markets too close to
 *  expiry to be useful (the surface prunes near-expiry rows, so the caller passes
 *  a small buffer to stay in step with it). */
export function openExpiries(candidates: EngineCandidate[], now: number, minRunwayMs = 0): EngineCandidate[] {
  return candidates.filter((c) => c.expiryMs > now + minRunwayMs).sort((a, b) => a.expiryMs - b.expiryMs);
}

/** Chance the asset finishes above `price` for this pricer (0..1). Uses spot as
 *  the strike (falling back to the forward), so it reads as "up from here". */
export function chanceAbove(pricer: EnginePricer, price: number | null | undefined): number {
  const strike = price != null && price > 0 ? price : pricer.forward;
  return upFair(strike, pricer.forward, pricer.svi);
}

/** At-the-money implied vol for an expiry (annualized fraction). */
export function atmIv(pricer: EnginePricer, expiryMs: number, now: number): number {
  const tYears = Math.max(timeToExpiryYears(expiryMs, now), 1e-9);
  return impliedVol(pricer.forward, pricer.forward, pricer.svi, tYears);
}

/**
 * Realized 1σ move over `minutes`, from recent 1-minute closes. This is the ONE
 * canonical implementation — the co-pilot's pulse imports it from here, so the
 * stat-bar vol pill and any engine-driven vol read are judged against the exact
 * same realized number.
 */
export function realizedTenorSigma(closes: number[] | null | undefined, minutes: number): number | null {
  if (!closes || closes.length < 30) return null;
  const rets: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > 0 && closes[i - 1] > 0) rets.push(Math.log(closes[i] / closes[i - 1]));
  }
  if (rets.length < 20) return null;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(Math.max(0, variance)) * Math.sqrt(Math.max(1, minutes));
}

/**
 * Is the near-term surface pricing MORE or LESS movement than the asset has
 * actually been making? Compares the front expiry's implied σ = sqrt(total
 * variance) to the realized σ over the same tenor. The 1.15 / 0.87 ratio bands
 * mirror the co-pilot's volatility reply word-for-word. Null when there isn't
 * enough realized history to judge honestly.
 */
export function volState(candidates: EngineCandidate[], closes: number[] | null | undefined, now: number): VolState | null {
  const cand = openExpiries(candidates, now)[0];
  if (!cand) return null;
  const sigma = Math.sqrt(Math.max(0, totalVariance(cand.pricer.forward, cand.pricer.forward, cand.pricer.svi)));
  const realized = realizedTenorSigma(closes, clampMinutes((cand.expiryMs - now) / 60_000));
  if (!realized || realized <= 0) return null;
  const ratio = sigma / realized;
  if (ratio > 1.15) return 'elevated';
  if (ratio < 0.87) return 'calm';
  return 'normal';
}

/** Run the butterfly + calendar no-arb checker across the live surface (the same
 *  `buildSurface` the co-pilot uses). Needs ≥ 2 expiries; null when it can't check. */
export function arbState(surfaceInputs: SmileInput[] | null | undefined, now: number): ArbState | null {
  if (!surfaceInputs || surfaceInputs.length < 2) return null;
  const surface = buildSurface(surfaceInputs, { nowMs: now });
  return surface.hasButterfly || surface.hasCalendar ? 'watch' : 'clean';
}

/**
 * The reality check for a single strike: what the bet asks of the market vs how
 * often that move has actually happened lately. Binds the surface's implied
 * probability to the SAME forward the trade settles against (spot = forward), so
 * the implied figure matches the quoted odds. Returns null without candles.
 */
export function analyzeStrikeForMarket(opts: {
  closes: number[] | null | undefined;
  pricer: EnginePricer;
  strike: number;
  isUp: boolean;
  expiryMs: number;
  now: number;
}): StrikeAnalysis | null {
  const { closes, pricer, strike, isUp, expiryMs, now } = opts;
  if (!closes || closes.length < 3) return null;
  const impliedProb = isUp ? upFair(strike, pricer.forward, pricer.svi) : dnFair(strike, pricer.forward, pricer.svi);
  return analyzeStrike({
    closes,
    spot: pricer.forward,
    strike,
    isUp,
    minutesToExpiry: Math.max(0, (expiryMs - now) / 60_000),
    impliedProb,
  });
}

/**
 * Compose one `MarketIntel` snapshot from the live inputs. This is the seam the
 * Options page and the X bot both call; the co-pilot shares the same underlying
 * primitives. Pure — pass it data, get a snapshot, render it anywhere.
 */
export function buildMarketIntel(input: MarketIntelInput): MarketIntel {
  const { asset, now, spot, ctx, candidates, closes, surfaceInputs } = input;
  const open = openExpiries(candidates, now);
  const front = open[0] ?? null;
  const price = spot ?? ctx?.spot ?? null;

  const expiries: MarketExpiry[] = open.map((c) => {
    const upChance = chanceAbove(c.pricer, price);
    return {
      marketId: c.marketId,
      expiryMs: c.expiryMs,
      upChance,
      iv: atmIv(c.pricer, c.expiryMs, now),
      isUp: upChance >= 0.5,
    };
  });

  return {
    asset,
    asOf: now,
    spot: price,
    nextExpiryMs: front?.expiryMs ?? null,
    expiries,
    expectedMove: front ? expectedMove(front.pricer) : null,
    vol: volState(candidates, closes ?? null, now),
    arb: arbState(surfaceInputs ?? null, now),
    bias: recommendation(ctx),
    read: buildMarketRead({ ctx, strike: null, isUp: false, strikePrice: null, spot: price }),
  };
}

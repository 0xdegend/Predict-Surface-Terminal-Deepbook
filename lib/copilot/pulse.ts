/**
 * lib/copilot/pulse.ts — the cockpit's "market pulse": the small, pure
 * derivations the ambient chrome around the co-pilot reads from (the stat bar,
 * the markets rail, the ambient read, the adaptive chips).
 *
 * Every number here comes from the SAME primitives the conversation uses
 * (lib/svi + lib/insights), and the vol / arb verdicts mirror respond.ts's exact
 * thresholds, so a pill can never disagree with what the co-pilot says in chat.
 * Nothing here fetches or touches React — it's a pure transform of data the
 * screen already holds, unit-tested like the rest of lib/copilot.
 */
import { upFair, totalVariance, impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { buildSurface, type SmileInput } from '@/lib/svi/surface';
import { recommendation } from '@/lib/insights/market-read';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { BetCandidate } from './respond';

/** How the near-term implied swing compares to BTC's recent realized move. */
export type VolState = 'calm' | 'normal' | 'elevated';
/** Whether the live surface is arbitrage-clean or has a fleeting mispricing. */
export type ArbState = 'clean' | 'watch';
/** The blended directional lean from the off-chain context (Clawby). */
export type Bias = NonNullable<ReturnType<typeof recommendation>>;

/** One tradeable expiry, as the markets rail shows it. */
export interface MarketRow {
  marketId: string;
  expiry: number;
  /** Chance BTC finishes above its CURRENT price, from the live surface (0..1). */
  upChance: number;
  /** At-the-money implied vol for this expiry (annualized fraction) — the
   *  surface's headline number, which genuinely varies across the term. */
  iv: number;
  /** Which side the surface tilts (upChance >= 0.5). */
  isUp: boolean;
}

/** Only the still-open expiries, soonest first. `minRunwayMs` drops markets too
 *  close to expiry to bother with — the rail passes a small buffer so it never
 *  offers a market the surface has already pruned (the surface drops rows within
 *  ~5s of expiry), which would select a market it can't draw a marker for. */
function openSorted(candidates: BetCandidate[], now: number, minRunwayMs = 0): BetCandidate[] {
  return candidates.filter((c) => c.market.expiry > now + minRunwayMs).sort((a, b) => a.market.expiry - b.market.expiry);
}

/** Chance BTC finishes above where it is right now, per the surface. Uses spot as
 *  the strike (falls back to the market's forward), so it reads as "up from here". */
export function marketUpChance(pricer: BetCandidate['pricer'], spot: number | null | undefined): number {
  const strike = spot != null && spot > 0 ? spot : pricer.forward;
  return upFair(strike, pricer.forward, pricer.svi);
}

/** At-the-money implied vol for an expiry (annualized fraction). */
export function marketAtmIv(pricer: BetCandidate['pricer'], expiry: number, now: number): number {
  const tYears = Math.max(timeToExpiryYears(expiry, now), 1e-9);
  return impliedVol(pricer.forward, pricer.forward, pricer.svi, tYears);
}

/** The tradeable expiries as rail rows (soonest first). `minRunwayMs` keeps the
 *  rail in step with the surface, which prunes near-expiry rows. */
export function marketRows(candidates: BetCandidate[], spot: number | null | undefined, now: number, minRunwayMs = 0): MarketRow[] {
  return openSorted(candidates, now, minRunwayMs).map((c) => {
    const upChance = marketUpChance(c.pricer, spot);
    return {
      marketId: c.market.expiry_market_id,
      expiry: c.market.expiry,
      upChance,
      iv: marketAtmIv(c.pricer, c.market.expiry, now),
      isUp: upChance >= 0.5,
    };
  });
}

/** The soonest still-open expiry timestamp, or null. */
export function nextExpiry(candidates: BetCandidate[], now: number): number | null {
  return openSorted(candidates, now)[0]?.market.expiry ?? null;
}

/**
 * Realized 1σ move over `minutes`, from the recent 1-minute closes. A verbatim
 * copy of respond.ts's helper so the stat-bar vol pill and the chat's "how
 * volatile" answer are judged against the exact same realized number.
 */
function realizedTenorSigma(closes: number[] | null | undefined, minutes: number): number | null {
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
 * Is the near-term surface pricing MORE or LESS movement than BTC has actually
 * been making? Same tenor, same ratio thresholds (1.15 / 0.87) as respond.ts's
 * volatilityReply, so the pill matches the chat verdict word-for-word. Returns
 * null when there isn't enough realized history to judge honestly (e.g. before
 * the candle feed loads) — the caller hides the pill rather than guessing.
 */
export function volState(candidates: BetCandidate[], closes: number[] | null | undefined, now: number): VolState | null {
  const cand = openSorted(candidates, now)[0];
  if (!cand) return null;
  const sigma = Math.sqrt(Math.max(0, totalVariance(cand.pricer.forward, cand.pricer.forward, cand.pricer.svi)));
  const minutes = Math.max(1, Math.round((cand.market.expiry - now) / 60_000));
  const realized = realizedTenorSigma(closes, minutes);
  if (!realized || realized <= 0) return null;
  const ratio = sigma / realized;
  if (ratio > 1.15) return 'elevated';
  if (ratio < 0.87) return 'calm';
  return 'normal';
}

/**
 * Run the butterfly + calendar no-arb checker across the live surface (the same
 * buildSurface the chat's "any mispricings?" answer uses). Needs >= 2 expiries;
 * returns null when it can't check yet.
 */
export function arbState(surfaceInputs: SmileInput[] | null | undefined, now: number): ArbState | null {
  if (!surfaceInputs || surfaceInputs.length < 2) return null;
  const surface = buildSurface(surfaceInputs, { nowMs: now });
  return surface.hasButterfly || surface.hasCalendar ? 'watch' : 'clean';
}

/** The blended off-chain directional lean (Clawby), or null when unavailable. */
export function bias(insights: BtcInsights | null | undefined): Bias | null {
  return recommendation(insights ?? null);
}

/**
 * The adaptive suggestion chips. They shift with the live market so the panel
 * reads as responsive and teaches people what to ask: an elevated-vol regime
 * surfaces the "why is it volatile" question, a mispricing surfaces the arb
 * question, an open book surfaces the portfolio question. Every string parses to
 * a real intent (see lib/copilot/intents), capped so the row never wraps past
 * two lines. Ordered most-contextual first.
 */
export function suggestChips(opts: {
  vol: VolState | null;
  arb: ArbState | null;
  bias: Bias | null;
  hasPortfolio: boolean;
}): string[] {
  const dir = opts.bias?.pick === 'down' ? 'DOWN' : 'UP';
  const out: string[] = [];

  if (opts.vol === 'elevated') out.push('Why is BTC so volatile?');
  else if (opts.vol === 'calm') out.push('How volatile is BTC?');

  if (opts.arb === 'watch') out.push('Any mispricings right now?');

  out.push(`Safe ${dir} bet`);
  // A range bet shines when moves are contained, so offer it unless vol is running
  // hot (a wide expected move makes staying-in-a-band a poor deal).
  if (opts.vol !== 'elevated') out.push('Recommend a range');
  out.push("What's the best bet right now?");

  if (opts.hasPortfolio) out.push("How's my portfolio?");

  out.push('Set up a trade', 'Analyze BTC', `Longshot ${dir} bet`, 'Next market');

  // Dedupe, keep first-seen order, cap at six so the row stays tidy.
  return [...new Set(out)].slice(0, 6);
}

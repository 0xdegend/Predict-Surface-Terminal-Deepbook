// Autopilot presets — the "how should Kelly bet?" styles.
//
// The setup screen used to ask the trader to configure ~10 separate knobs (odds floor,
// windows, direction, leverage, cooldown, trade cap, loss cap…). Most people don't
// know what those mean and shouldn't have to. A preset bundles all of them into one
// friendly choice — Cautious / Balanced / Bold — so the common path is a single tap.
//
// Every preset offers all three shapes the venue lists: UP, DOWN, and a range (BTC
// stays between two prices). Ranges joined on 2026-09-04 at the founder's call: Kelly
// takes one when she reads a good chance on it (lib/copilot/range-pick), and a trader
// who wants direction only switches the chip off under Customize.
//
// A preset controls HOW Kelly bets + how she paces herself. It deliberately does NOT
// set the budget, per-trade size, or run length: those are the trader's own money and
// time decisions, surfaced separately. Power users can still open Customize and change
// any individual field, at which point the config no longer matches a preset (Custom).
//
// Pure (no React) so the mapping + the plain-language plan are unit-tested.
import type { AutopilotRules, AutopilotLimits, Tenor, TradeSide } from './policy';

export type PresetId = 'cautious' | 'balanced' | 'bold';

/** The fields a preset controls. Budget / per-trade / run length are NOT here, and
 *  neither are the bet count and the gap between bets: those follow the run length
 *  (see `paceFor`). */
interface PresetShape {
  minProb: number;
  maxLeverage: number;
  tenors: Tenor[];
  sides: TradeSide[];
  maxConsecutiveLosses: number;
  maxConcurrent: number;
}

export interface AutopilotPreset {
  id: PresetId;
  name: string;
  /** A short verb-y hook shown under the name. */
  tagline: string;
  /** One plain-language line of what it does. */
  blurb: string;
  /** 1..3 filled dots for the risk gradient shown on the card. */
  risk: 1 | 2 | 3;
  shape: PresetShape;
}

export const PRESETS: readonly AutopilotPreset[] = [
  {
    id: 'cautious',
    // "Careful", not "Cautious": Kelly asks for a style with "Careful, balanced, or
    // bold?", her openers and answer chips say Careful, and this label is what the
    // preset picker and the plan badge show. Two words for one setting made the two
    // setup modes read as two different features. The ID stays `cautious` because it is
    // persisted and matched on.
    name: 'Careful',
    tagline: 'Play it safe',
    blurb: 'Only high-confidence bets, no leverage, and it backs off fast if it goes cold.',
    risk: 1,
    shape: {
      minProb: 0.7,
      maxLeverage: 1,
      tenors: ['soonest', 'hour'],
      sides: ['up', 'down', 'range'],
      maxConsecutiveLosses: 2,
      maxConcurrent: 2,
    },
  },
  {
    id: 'balanced',
    name: 'Balanced',
    tagline: 'A steady mix',
    blurb: 'Good-value bets with a little leverage. A sensible middle ground.',
    risk: 2,
    shape: {
      minProb: 0.6,
      maxLeverage: 2,
      tenors: ['soonest', 'hour'],
      sides: ['up', 'down', 'range'],
      maxConsecutiveLosses: 3,
      maxConcurrent: 3,
    },
  },
  {
    id: 'bold',
    name: 'Bold',
    tagline: 'Swing for it',
    blurb: 'Takes longer shots at bigger payouts, trades more often, and uses more leverage.',
    risk: 3,
    shape: {
      minProb: 0.55,
      maxLeverage: 3,
      tenors: ['soonest', 'hour', 'today'],
      sides: ['up', 'down', 'range'],
      maxConsecutiveLosses: 4,
      maxConcurrent: 4,
    },
  },
] as const;

export const PRESET_BY_ID: Record<PresetId, AutopilotPreset> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p]),
) as Record<PresetId, AutopilotPreset>;

/** The default style a fresh setup lands on. */
export const DEFAULT_PRESET: PresetId = 'balanced';

/* -------------------------------- pacing --------------------------------- */
// How many bets a run makes, and how far apart, follow the run LENGTH, not a fixed
// count. A careful run used to be "3 bets, 2 minutes apart" whatever the session: a
// $500, 15-minute run placed three $167 bets and was over in four minutes, with eleven
// minutes of the trader's time unused (founder, 2026-09-04). Now each style has a
// target gap between bets, the count is the run length over that gap inside the style's
// bounds, and never so many that a bet drops under $5. The gap then stretches so the
// bets spread across the whole run, up to ten minutes apart.
//
// Honest about what this buys. More, smaller bets at the same odds do not make any one
// of them likelier to win. They use the whole session, and they make the result less of
// a coin flip on two or three bets.

interface PaceShape {
  /** Target gap between bets. */
  betEveryMs: number;
  /** Fewest and most bets in a run, before the budget has its say. */
  minTrades: number;
  maxTrades: number;
  /** The gap never shrinks below this, however short the run. */
  minCooldownMs: number;
}

const PACE: Record<PresetId, PaceShape> = {
  cautious: { betEveryMs: 3 * 60_000, minTrades: 2, maxTrades: 12, minCooldownMs: 90_000 },
  balanced: { betEveryMs: 2 * 60_000, minTrades: 3, maxTrades: 20, minCooldownMs: 60_000 },
  bold: { betEveryMs: 90_000, minTrades: 4, maxTrades: 30, minCooldownMs: 45_000 },
};

/** The smallest bet a paced run plans. Under this the count comes down, not the bet. */
export const MIN_PACED_BET_USD = 5;

/** Bets are never spread further apart than this, so a small budget over a long run
 *  still finishes in a reasonable time rather than trickling out one bet an hour. */
export const MAX_SPREAD_MS = 10 * 60_000;

/** The two things pacing follows. `AutopilotLimits` satisfies it. */
export interface RunShape {
  armDurationMs: number;
  budgetUsd: number;
}

export interface Pace {
  maxTrades: number;
  cooldownMs: number;
}

/** The bet count and gap a style uses for a run of this length and budget. */
export function paceFor(id: PresetId, run: RunShape): Pace {
  const p = PACE[id];
  const byTime = Math.min(p.maxTrades, Math.max(p.minTrades, Math.round(run.armDurationMs / p.betEveryMs)));
  const byBudget = Math.max(1, Math.floor(run.budgetUsd / MIN_PACED_BET_USD));
  const maxTrades = Math.max(1, Math.min(byTime, byBudget));
  // Spread the bets over the run: the run length over the count, to the 15 seconds
  // below, inside the style's floor and the ten-minute ceiling.
  const spread = Math.floor(run.armDurationMs / maxTrades / 15_000) * 15_000;
  return { maxTrades, cooldownMs: Math.min(MAX_SPREAD_MS, Math.max(p.minCooldownMs, spread)) };
}

/** The per-bet size that splits a budget over a bet count, to the cent. The engine's
 *  stakeFor() sizes the last bet to the exact remainder, so a few cents of rounding
 *  never strand any of the budget. */
export function perBetFor(budgetUsd: number, maxTrades: number): number {
  return Math.max(1, Math.round((budgetUsd / Math.max(1, maxTrades)) * 100) / 100);
}

/** True while the per-bet size is still the budget split over the bet count, so a
 *  re-pace may size it again without stepping on a number the trader typed. */
export function isAutoSized(l: { budgetUsd: number; perTradeUsd: number; maxTrades: number }): boolean {
  return Math.abs(l.perTradeUsd * l.maxTrades - l.budgetUsd) <= Math.max(0.05, l.budgetUsd * 0.02);
}

/**
 * The rules + limits a preset applies to a run of the given length and budget. Only
 * the "how she bets + pacing" fields, never budget, per-trade, or run length, so
 * applying a preset keeps the trader's money and time choices untouched. minEdge stays
 * out (the recommender doesn't surface edge yet).
 */
export function presetPatch(id: PresetId, run: RunShape): { rules: Partial<AutopilotRules>; limits: Partial<AutopilotLimits> } {
  const s = PRESET_BY_ID[id].shape;
  const pace = paceFor(id, run);
  return {
    rules: { minProb: s.minProb, maxLeverage: s.maxLeverage, tenors: [...s.tenors], sides: [...s.sides] },
    limits: {
      cooldownMs: pace.cooldownMs,
      maxConsecutiveLosses: s.maxConsecutiveLosses,
      maxTrades: pace.maxTrades,
      maxConcurrent: s.maxConcurrent,
    },
  };
}

/**
 * The fixed count + gap each preset carried before pacing (store schema versions 1
 * and 2). Only the store's migration reads this, to recognise a saved config that was
 * on a preset and re-pace it rather than show it as Custom.
 */
export const LEGACY_PACE: Record<PresetId, Pace> = {
  cautious: { maxTrades: 3, cooldownMs: 120_000 },
  balanced: { maxTrades: 5, cooldownMs: 90_000 },
  bold: { maxTrades: 8, cooldownMs: 60_000 },
};

function rulesMatch(rules: AutopilotRules, limits: AutopilotLimits, p: AutopilotPreset): boolean {
  const s = p.shape;
  return (
    Math.abs(rules.minProb - s.minProb) < 1e-9 &&
    rules.maxLeverage === s.maxLeverage &&
    sameSet(rules.tenors, s.tenors) &&
    sameSet(rules.sides, s.sides) &&
    limits.maxConsecutiveLosses === s.maxConsecutiveLosses &&
    limits.maxConcurrent === s.maxConcurrent
  );
}

/** Which preset a pre-pacing saved config was on, by its rules and the old fixed
 *  count + gap, or null when it was customized. */
export function legacyPresetOf(rules: AutopilotRules, limits: AutopilotLimits): PresetId | null {
  for (const p of PRESETS) {
    const legacy = LEGACY_PACE[p.id];
    if (rulesMatch(rules, limits, p) && limits.maxTrades === legacy.maxTrades && limits.cooldownMs === legacy.cooldownMs) return p.id;
  }
  return null;
}

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  return b.every((x) => sa.has(x));
}

/**
 * Which preset the current config matches on the preset-controlled fields, or null when
 * the trader has customized away from all of them (shown as "Custom"). Budget / per-trade /
 * run length are ignored here, so changing how much you risk never flips you off a style.
 */
export function matchPreset(rules: AutopilotRules, limits: AutopilotLimits): PresetId | null {
  for (const p of PRESETS) {
    // The count and gap are compared against what pacing gives THIS run length and
    // budget, so changing how long or how much never flips a trader off their style.
    const pace = paceFor(p.id, limits);
    if (rulesMatch(rules, limits, p) && limits.maxTrades === pace.maxTrades && limits.cooldownMs === pace.cooldownMs) {
      return p.id;
    }
  }
  return null;
}

function durationWords(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'}`;
  const hours = mins / 60;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${(mins / 60).toFixed(1)} hours`;
}

/**
 * The same duration after the words "the next", where a bare 1 reads wrong: the plan
 * sentence was saying "over the next 1 hour". People drop the count there.
 * "1.5 hours" is untouched, since it does not start with a lone 1.
 */
function nextDurationWords(ms: number): string {
  const w = durationWords(ms);
  return w.startsWith('1 ') ? w.slice(2) : w;
}

function sidesWords(sides: AutopilotRules['sides']): string {
  const parts: string[] = [];
  if (sides.includes('up')) parts.push('UP');
  if (sides.includes('down')) parts.push('DOWN');
  if (sides.includes('range')) parts.push('range');
  if (parts.length === 0) return 'no';
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} or ${parts[parts.length - 1]}`;
}

/**
 * The plain-language "here's the plan" sentence shown before arming — the single most
 * important bit of the setup, because it lets a trader confirm what they're about to turn
 * on without reading any of the individual controls. Money always stated explicitly.
 */
export function planSentence(rules: AutopilotRules, limits: AutopilotLimits): string {
  const adj = rules.minProb >= 0.68 ? 'careful' : rules.minProb >= 0.58 ? 'solid' : 'longer-shot';
  const sides = sidesWords(rules.sides);
  const each = `$${limits.perTradeUsd % 1 === 0 ? limits.perTradeUsd : limits.perTradeUsd.toFixed(2)}`;
  const lev = rules.maxLeverage > 1 ? `, up to ${rules.maxLeverage}x` : '';
  const n = limits.maxTrades;
  return `Up to ${n} ${adj} ${sides} bet${n === 1 ? '' : 's'}, about ${each} each, over the next ${nextDurationWords(
    limits.armDurationMs,
  )}${lev}. Stops after ${limits.maxConsecutiveLosses} ${limits.maxConsecutiveLosses === 1 ? 'loss' : 'losses'} in a row.`;
}

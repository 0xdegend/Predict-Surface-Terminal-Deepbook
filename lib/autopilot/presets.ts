// Autopilot presets — the "how should Kelly bet?" styles.
//
// The setup screen used to ask the trader to configure ~10 separate knobs (odds floor,
// windows, direction, leverage, cooldown, trade cap, loss cap…). Most people don't
// know what those mean and shouldn't have to. A preset bundles all of them into one
// friendly choice — Cautious / Balanced / Bold — so the common path is a single tap.
//
// A preset controls HOW Kelly bets + how she paces herself. It deliberately does NOT
// set the budget, per-trade size, or run length: those are the trader's own money and
// time decisions, surfaced separately. Power users can still open Customize and change
// any individual field, at which point the config no longer matches a preset (Custom).
//
// Pure (no React) so the mapping + the plain-language plan are unit-tested.
import type { AutopilotRules, AutopilotLimits, Tenor } from './policy';

export type PresetId = 'cautious' | 'balanced' | 'bold';

/** The fields a preset controls. Budget / per-trade / run length are NOT here. */
interface PresetShape {
  minProb: number;
  maxLeverage: number;
  tenors: Tenor[];
  sides: ('up' | 'down')[];
  cooldownMs: number;
  maxConsecutiveLosses: number;
  maxTrades: number;
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
      sides: ['up', 'down'],
      cooldownMs: 120_000,
      maxConsecutiveLosses: 2,
      maxTrades: 3,
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
      sides: ['up', 'down'],
      cooldownMs: 90_000,
      maxConsecutiveLosses: 3,
      maxTrades: 5,
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
      sides: ['up', 'down'],
      cooldownMs: 60_000,
      maxConsecutiveLosses: 4,
      maxTrades: 8,
      maxConcurrent: 4,
    },
  },
] as const;

export const PRESET_BY_ID: Record<PresetId, AutopilotPreset> = Object.fromEntries(
  PRESETS.map((p) => [p.id, p]),
) as Record<PresetId, AutopilotPreset>;

/** The default style a fresh setup lands on. */
export const DEFAULT_PRESET: PresetId = 'balanced';

/**
 * The rules + limits a preset applies. Only the "how she bets + pacing" fields — never
 * budget, per-trade, or run length — so applying a preset keeps the trader's money and
 * time choices untouched. minEdge stays out (the recommender doesn't surface edge yet).
 */
export function presetPatch(id: PresetId): { rules: Partial<AutopilotRules>; limits: Partial<AutopilotLimits> } {
  const s = PRESET_BY_ID[id].shape;
  return {
    rules: { minProb: s.minProb, maxLeverage: s.maxLeverage, tenors: [...s.tenors], sides: [...s.sides] },
    limits: {
      cooldownMs: s.cooldownMs,
      maxConsecutiveLosses: s.maxConsecutiveLosses,
      maxTrades: s.maxTrades,
      maxConcurrent: s.maxConcurrent,
    },
  };
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
    const s = p.shape;
    if (
      Math.abs(rules.minProb - s.minProb) < 1e-9 &&
      rules.maxLeverage === s.maxLeverage &&
      sameSet(rules.tenors, s.tenors) &&
      sameSet(rules.sides, s.sides) &&
      limits.cooldownMs === s.cooldownMs &&
      limits.maxConsecutiveLosses === s.maxConsecutiveLosses &&
      limits.maxTrades === s.maxTrades &&
      limits.maxConcurrent === s.maxConcurrent
    ) {
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
  const up = sides.includes('up');
  const down = sides.includes('down');
  const range = sides.includes('range');
  const base = up && down ? 'UP or DOWN' : up ? 'UP' : down ? 'DOWN' : 'no';
  return range ? `${base} or range` : base;
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

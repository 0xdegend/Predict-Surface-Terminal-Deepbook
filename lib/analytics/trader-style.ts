/**
 * lib/analytics/trader-style.ts — trader-style classification (Analytics Phase 4).
 *
 * Reads a trader's position history and assigns a single, EXPLAINABLE archetype
 * (plus a few trait tags) from how they actually bet — entry prices, range vs
 * binary mix, ticket size, breadth, and direction lean. Every decision is backed
 * by a number we also surface, so the badge is never a black box.
 *
 * Pure + server-data-only — folds `/managers/:id/positions/summary` rows (and an
 * optional range-volume figure), so it runs on the profile and in the analytics
 * tool alike.
 *
 * SCALING: `total_cost` @6dec (`fromQuote`); `average_entry_price` @1e9 per-unit
 * ask in [0,1] (`toFloat`).
 */
import { fromQuote, toFloat } from '@/config/scale';
import type { PositionSummary } from '@/lib/api/types';

export interface StyleStats {
  /** Binary positions with a real cost — the base for avgBet. */
  positions: number;
  /** Bets counted toward the sample floor + the "frequent" checks (binary + range).
   *  Equals `positions` on the legacy binary-only path; larger once range bets are
   *  folded in, so a pure-range bettor can still clear MIN_SAMPLE. */
  sample: number;
  /** DUSDC staked across binaries + ranges. */
  volume: number;
  /** DUSDC per binary position. */
  avgBet: number;
  /** Cost-weighted average entry price, [0,1]. Low = longshots, high = favorites. */
  avgEntry: number;
  /** Share of binary volume on cheap longshots (entry < 0.30). */
  tailShare: number;
  /** Share of binary volume on favorites (entry > 0.70). */
  favShare: number;
  /** Share of binary volume bet UP. */
  upShare: number;
  /** Distinct markets traded. */
  markets: number;
  /** Share of total volume on range bets. */
  rangeShare: number;
}

export interface StyleArchetype {
  id: 'tail' | 'favorite' | 'range' | 'highroller' | 'active' | 'balanced';
  label: string;
  blurb: string;
}

export interface StyleTag {
  id: 'up-biased' | 'down-biased' | 'diversified' | 'big-tickets' | 'active';
  label: string;
}

export interface TraderStyle {
  /** null when the trader has too few bets to characterize. */
  primary: StyleArchetype | null;
  tags: StyleTag[];
  stats: StyleStats;
}

/* ----------------------------- thresholds ----------------------------- */
// One place to tune the whole model (kept explicit so the badge stays defensible).
const MIN_SAMPLE = 3;
const TAIL_PRICE = 0.3;
const FAV_PRICE = 0.7;
const RANGE_PRIMARY = 0.4;
const TAIL_PRIMARY = 0.4;
const FAV_PRIMARY = 0.6;
const HIGH_ROLLER_DUSDC = 3;
const ACTIVE_N = 12;
const DIVERSE_MARKETS = 6;
const BIAS_HI = 0.65;
const BIAS_LO = 0.35;

const ARCHETYPES: Record<StyleArchetype['id'], StyleArchetype> = {
  tail: { id: 'tail', label: 'Longshot hunter', blurb: 'Makes cheap bets on unlikely outcomes, hoping for a big payout' },
  favorite: { id: 'favorite', label: 'Safe bettor', blurb: 'Bets on the likely outcome for small, steady wins' },
  range: { id: 'range', label: 'In-between bettor', blurb: 'Bets the price will land between two levels' },
  highroller: { id: 'highroller', label: 'Big spender', blurb: 'Places large bets' },
  active: { id: 'active', label: 'Frequent bettor', blurb: 'Bets a lot — many bets, often' },
  balanced: { id: 'balanced', label: 'All-rounder', blurb: 'A balanced mix — no single habit stands out' },
};

/** Fold a trader's binary positions (+ optional range volume) into the stats the
 *  classifier reads. Only rows with a real cost count. */
export function computeStyleStats(positions: PositionSummary[], rangeVolume = 0): StyleStats {
  let binVolume = 0;
  let upCost = 0;
  let tailCost = 0;
  let favCost = 0;
  let entryWeighted = 0;
  let n = 0;
  const markets = new Set<string>();

  for (const p of positions) {
    const cost = fromQuote(p.total_cost);
    if (cost <= 0) continue;
    const entry = Math.min(1, Math.max(0, toFloat(p.average_entry_price)));
    binVolume += cost;
    n += 1;
    markets.add(p.oracle_id);
    entryWeighted += entry * cost;
    if (p.is_up) upCost += cost;
    if (entry < TAIL_PRICE) tailCost += cost;
    if (entry > FAV_PRICE) favCost += cost;
  }

  const totalVolume = binVolume + Math.max(0, rangeVolume);
  return {
    positions: n,
    // Legacy path has no range COUNT (rangeVolume is a scalar), so the sample is the
    // binary count — identical to the old behavior. The streaming path (statsFromAcc)
    // sets a larger sample when it has real range bets.
    sample: n,
    volume: totalVolume,
    avgBet: n > 0 ? binVolume / n : 0,
    avgEntry: binVolume > 0 ? entryWeighted / binVolume : 0,
    tailShare: binVolume > 0 ? tailCost / binVolume : 0,
    favShare: binVolume > 0 ? favCost / binVolume : 0,
    upShare: binVolume > 0 ? upCost / binVolume : 0.5,
    markets: markets.size,
    rangeShare: totalVolume > 0 ? Math.max(0, rangeVolume) / totalVolume : 0,
  };
}

/* ------------------------- streaming accumulator ------------------------- */
// The same model, folded one mint at a time so a complete all-time roster can be
// accumulated from the order stream (see lib/analytics/v2-style-indexer) instead of
// re-derived from a windowed list. Every field is additive, and the shape is plain
// JSON so it round-trips through KV. `markets` is a set-as-record for O(1) dedupe.

export interface StyleAccumulator {
  binPositions: number;
  rangePositions: number;
  binVolume: number;
  rangeVolume: number;
  upCost: number;
  tailCost: number;
  favCost: number;
  /** Σ(entry · cost) over binary mints — divide by binVolume for the weighted entry. */
  entryWeighted: number;
  markets: Record<string, 1>;
}

export function emptyStyleAcc(): StyleAccumulator {
  return {
    binPositions: 0,
    rangePositions: 0,
    binVolume: 0,
    rangeVolume: 0,
    upCost: 0,
    tailCost: 0,
    favCost: 0,
    entryWeighted: 0,
    markets: {},
  };
}

/** One minted bet, already de-scaled: `cost` in DUSDC, `entry` in [0,1], `side` from
 *  the tick pair, `market` the distinct-market key. */
export interface StyleMint {
  cost: number;
  entry: number;
  side: 'up' | 'down' | 'range';
  market: string;
}

/** Fold one mint into an accumulator. Mirrors computeStyleStats' per-position math;
 *  only real-cost bets count (same guard as the list path). */
export function foldMint(acc: StyleAccumulator, m: StyleMint): void {
  if (m.cost <= 0) return;
  if (m.market) acc.markets[m.market] = 1;
  if (m.side === 'range') {
    acc.rangeVolume += m.cost;
    acc.rangePositions += 1;
    return;
  }
  acc.binPositions += 1;
  acc.binVolume += m.cost;
  const entry = Math.min(1, Math.max(0, m.entry));
  acc.entryWeighted += entry * m.cost;
  if (m.side === 'up') acc.upCost += m.cost;
  if (entry < TAIL_PRICE) acc.tailCost += m.cost;
  if (entry > FAV_PRICE) acc.favCost += m.cost;
}

/** Project an accumulator to the same StyleStats the classifier reads. `sample` folds
 *  in range bets so a pure-range bettor clears the floor (see StyleStats.sample). */
export function statsFromAcc(acc: StyleAccumulator): StyleStats {
  const binVolume = acc.binVolume;
  const totalVolume = binVolume + acc.rangeVolume;
  return {
    positions: acc.binPositions,
    sample: acc.binPositions + acc.rangePositions,
    volume: totalVolume,
    avgBet: acc.binPositions > 0 ? binVolume / acc.binPositions : 0,
    avgEntry: binVolume > 0 ? acc.entryWeighted / binVolume : 0,
    tailShare: binVolume > 0 ? acc.tailCost / binVolume : 0,
    favShare: binVolume > 0 ? acc.favCost / binVolume : 0,
    upShare: binVolume > 0 ? acc.upCost / binVolume : 0.5,
    markets: Object.keys(acc.markets).length,
    rangeShare: totalVolume > 0 ? acc.rangeVolume / totalVolume : 0,
  };
}

/** Trait tags — independent of the primary, capped to keep the badge readable. */
function deriveTags(s: StyleStats, primaryId: StyleArchetype['id']): StyleTag[] {
  const tags: StyleTag[] = [];
  if (s.upShare >= BIAS_HI) tags.push({ id: 'up-biased', label: 'Mostly UP' });
  else if (s.upShare <= BIAS_LO) tags.push({ id: 'down-biased', label: 'Mostly DOWN' });
  if (s.markets >= DIVERSE_MARKETS) tags.push({ id: 'diversified', label: 'Many markets' });
  if (primaryId !== 'highroller' && s.avgBet >= HIGH_ROLLER_DUSDC) tags.push({ id: 'big-tickets', label: 'Big bets' });
  if (primaryId !== 'active' && s.sample >= ACTIVE_N) tags.push({ id: 'active', label: 'Bets often' });
  return tags.slice(0, 3);
}

/**
 * Classify from already-computed stats. Priority order (each backed by an explicit
 * stat): a strong range tilt, then longshot vs favorite leaning, then size, then
 * sheer activity, else a balanced all-rounder. `primary: null` below the sample floor.
 * Shared by the list path (classifyStyle) and the streaming path (classifyAcc).
 */
export function classifyFromStats(stats: StyleStats): TraderStyle {
  if (stats.sample < MIN_SAMPLE) return { primary: null, tags: [], stats };

  let id: StyleArchetype['id'];
  if (stats.rangeShare >= RANGE_PRIMARY) id = 'range';
  else if (stats.tailShare >= TAIL_PRIMARY) id = 'tail';
  else if (stats.favShare >= FAV_PRIMARY) id = 'favorite';
  else if (stats.avgBet >= HIGH_ROLLER_DUSDC) id = 'highroller';
  else if (stats.sample >= ACTIVE_N) id = 'active';
  else id = 'balanced';

  return { primary: ARCHETYPES[id], tags: deriveTags(stats, id), stats };
}

/** Classify a trader from a list of binary positions (+ optional range volume). */
export function classifyStyle(positions: PositionSummary[], rangeVolume = 0): TraderStyle {
  return classifyFromStats(computeStyleStats(positions, rangeVolume));
}

/** Classify a trader from a streamed accumulator (the complete-roster path). */
export function classifyAcc(acc: StyleAccumulator): TraderStyle {
  return classifyFromStats(statsFromAcc(acc));
}

/** All archetypes, for legends / the styles distribution. */
export const ALL_ARCHETYPES: StyleArchetype[] = Object.values(ARCHETYPES);

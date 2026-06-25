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
  positions: number;
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
  tail: { id: 'tail', label: 'Tail hunter', blurb: 'Backs cheap longshots for big payouts' },
  favorite: { id: 'favorite', label: 'Favorite backer', blurb: 'Piles into high-probability favorites' },
  range: { id: 'range', label: 'Range trader', blurb: 'Bets the price stays inside a band' },
  highroller: { id: 'highroller', label: 'High roller', blurb: 'Few bets, big size' },
  active: { id: 'active', label: 'Active trader', blurb: 'High-frequency across many bets' },
  balanced: { id: 'balanced', label: 'All-rounder', blurb: 'A balanced mix of bets' },
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

/** Trait tags — independent of the primary, capped to keep the badge readable. */
function deriveTags(s: StyleStats, primaryId: StyleArchetype['id']): StyleTag[] {
  const tags: StyleTag[] = [];
  if (s.upShare >= BIAS_HI) tags.push({ id: 'up-biased', label: 'UP-biased' });
  else if (s.upShare <= BIAS_LO) tags.push({ id: 'down-biased', label: 'DOWN-biased' });
  if (s.markets >= DIVERSE_MARKETS) tags.push({ id: 'diversified', label: 'Diversified' });
  if (primaryId !== 'highroller' && s.avgBet >= HIGH_ROLLER_DUSDC) tags.push({ id: 'big-tickets', label: 'Big tickets' });
  if (primaryId !== 'active' && s.positions >= ACTIVE_N) tags.push({ id: 'active', label: 'Active' });
  return tags.slice(0, 3);
}

/**
 * Classify a trader. Priority order (each backed by an explicit stat): a strong
 * range tilt, then longshot vs favorite leaning, then size, then sheer activity,
 * else a balanced all-rounder. Returns `primary: null` below the sample floor.
 */
export function classifyStyle(positions: PositionSummary[], rangeVolume = 0): TraderStyle {
  const stats = computeStyleStats(positions, rangeVolume);
  if (stats.positions < MIN_SAMPLE) return { primary: null, tags: [], stats };

  let id: StyleArchetype['id'];
  if (stats.rangeShare >= RANGE_PRIMARY) id = 'range';
  else if (stats.tailShare >= TAIL_PRIMARY) id = 'tail';
  else if (stats.favShare >= FAV_PRIMARY) id = 'favorite';
  else if (stats.avgBet >= HIGH_ROLLER_DUSDC) id = 'highroller';
  else if (stats.positions >= ACTIVE_N) id = 'active';
  else id = 'balanced';

  return { primary: ARCHETYPES[id], tags: deriveTags(stats, id), stats };
}

/** All archetypes, for legends / the styles distribution. */
export const ALL_ARCHETYPES: StyleArchetype[] = Object.values(ARCHETYPES);

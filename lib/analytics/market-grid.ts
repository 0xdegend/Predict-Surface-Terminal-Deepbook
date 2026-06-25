/**
 * lib/analytics/market-grid.ts — the market-heatmap fold (Analytics Phase 2).
 *
 * Joins three public sources into one row per ACTIVE oracle (a "market cell"):
 *   - oracle metadata + latest SVI/forward  → ATM implied vol, the ATM strike,
 *   - the global mint/redeem streams         → traded volume, net open interest,
 *   - per-oracle sentiment (reused fold)     → UP/DOWN dollar lean.
 *
 * Pure + server-data-only (mirrors lib/analytics/flow.ts and the risk page's
 * SmileInput build). The heatmap UI colors each cell by a chosen metric; this
 * module only produces the numbers + the ATM strike used for click-to-trade.
 *
 * SCALING: event amounts @6dec (`fromQuote`); strike/forward @1e9 (`toFloat`).
 * The ATM strike is also returned 1e9-scaled (as a string) ready for the ticket.
 */
import { fromQuote, toFloat, FLOAT_SCALING_BI } from '@/config/scale';
import { impliedVol, timeToExpiryYears, type SviFloat } from '@/lib/svi/svi';
import { sentimentByOracle } from '@/lib/analytics/flow';
import type { Oracle, PositionMintedEvent, PositionRedeemedEvent } from '@/lib/api/types';

/** The live SVI+forward snapshot for one oracle (the risk page's SmileInput, but
 *  only the fields the grid needs). */
export interface MarketInput {
  oracle: Oracle;
  svi: SviFloat;
  forward: number; // float
}

/** One tile on the market heatmap. */
export interface MarketCell {
  oracleId: string;
  underlying: string;
  expiry: number; // ms
  forward: number;
  /** ATM implied vol (at k=0), the headline "how jumpy" number. */
  atmIv: number;
  /** DUSDC staked on this market in the flow window. */
  volume: number;
  /** Mint count in the window. */
  trades: number;
  /** Net open contracts still live = minted − redeemed quantity (floored at 0). */
  openInterest: number;
  /** UP share of staked dollars, [0,1]; 0.5 when no flow. */
  upShare: number;
  /** Total DUSDC staked (both sides). */
  totalCost: number;
  /** Nearest mintable strike to the forward — the click-to-trade pre-fill. */
  atmStrike: number;
  atmStrikeScaled: string; // 1e9-scaled, ready for MarketKey
}

/** The metrics the heatmap can color by. */
export type GridMetric = 'volume' | 'oi' | 'iv' | 'sentiment';

/** Nearest mintable strike to a price, snapped to the oracle's $-grid. Returns
 *  both the float and the exact 1e9-scaled integer (for the trade ticket). */
export function nearestGridStrike(
  oracle: Oracle,
  price: number,
): { strike: number; strikeScaled: string } {
  const minScaled = BigInt(Math.round(oracle.min_strike));
  const tickScaled = BigInt(Math.round(oracle.tick_size));
  const minStrike = toFloat(oracle.min_strike);
  const tick = toFloat(oracle.tick_size);
  // Snap to the closest tick, clamped into the tradeable grid [0, 100_000].
  const ticks = tick > 0 ? Math.round((price - minStrike) / tick) : 0;
  const k = BigInt(Math.max(0, Math.min(100_000, ticks)));
  const scaled = minScaled + k * tickScaled;
  return { strike: Number(scaled) / Number(FLOAT_SCALING_BI), strikeScaled: scaled.toString() };
}

/** Net open interest (contracts) per oracle = Σ minted qty − Σ redeemed qty. */
export function openInterestByOracle(
  minted: PositionMintedEvent[],
  redeemed: PositionRedeemedEvent[],
): Map<string, number> {
  const oi = new Map<string, number>();
  const bump = (k: string, v: number) => oi.set(k, (oi.get(k) ?? 0) + v);
  for (const e of minted) bump(e.oracle_id, fromQuote(e.quantity));
  for (const e of redeemed) bump(e.oracle_id, -fromQuote(e.quantity));
  return oi;
}

interface FlowAgg {
  volume: number;
  trades: number;
}

/** Σ mint cost + mint count per oracle (the traded-volume fold). */
function flowByOracle(minted: PositionMintedEvent[]): Map<string, FlowAgg> {
  const m = new Map<string, FlowAgg>();
  for (const e of minted) {
    const a = m.get(e.oracle_id) ?? { volume: 0, trades: 0 };
    a.volume += fromQuote(e.cost);
    a.trades += 1;
    m.set(e.oracle_id, a);
  }
  return m;
}

/**
 * Build one MarketCell per active oracle. `inputs` are the live SVI/forward
 * snapshots (active oracles only); the event streams supply flow/OI/sentiment.
 * Cells come back sorted by soonest expiry (the natural ladder order).
 */
export function buildMarketGrid(
  inputs: MarketInput[],
  minted: PositionMintedEvent[],
  redeemed: PositionRedeemedEvent[],
  nowMs: number,
): MarketCell[] {
  const flow = flowByOracle(minted);
  const oi = openInterestByOracle(minted, redeemed);
  const sentiment = sentimentByOracle(minted);

  const cells = inputs.map(({ oracle, svi, forward }): MarketCell => {
    const tYears = Math.max(timeToExpiryYears(oracle.expiry, nowMs), 0);
    const f = flow.get(oracle.oracle_id);
    const s = sentiment.get(oracle.oracle_id);
    const atm = nearestGridStrike(oracle, forward);
    return {
      oracleId: oracle.oracle_id,
      underlying: oracle.underlying_asset || 'BTC',
      expiry: oracle.expiry,
      forward,
      atmIv: impliedVol(forward, forward, svi, tYears),
      volume: f?.volume ?? 0,
      trades: f?.trades ?? 0,
      openInterest: Math.max(0, oi.get(oracle.oracle_id) ?? 0),
      upShare: s?.upShare ?? 0.5,
      totalCost: s?.totalCost ?? 0,
      atmStrike: atm.strike,
      atmStrikeScaled: atm.strikeScaled,
    };
  });

  return cells.sort((a, b) => a.expiry - b.expiry);
}

/** The raw value a cell contributes for a given metric (used for coloring and
 *  sorting). Sentiment is the distance from neutral, so a strong lean either way
 *  reads as "hot". */
export function metricValue(cell: MarketCell, metric: GridMetric): number {
  switch (metric) {
    case 'volume':
      return cell.volume;
    case 'oi':
      return cell.openInterest;
    case 'iv':
      return cell.atmIv;
    case 'sentiment':
      return Math.abs(cell.upShare - 0.5) * 2; // 0 = balanced, 1 = one-sided
  }
}

/** Normalize each cell's metric to [0,1] against the hottest cell — the tile
 *  fill intensity. Returns 0 for every cell when the metric is flat/zero. */
export function metricIntensities(
  cells: MarketCell[],
  metric: GridMetric,
): Map<string, number> {
  let max = 0;
  for (const c of cells) max = Math.max(max, metricValue(c, metric));
  const out = new Map<string, number>();
  for (const c of cells) out.set(c.oracleId, max > 0 ? metricValue(c, metric) / max : 0);
  return out;
}

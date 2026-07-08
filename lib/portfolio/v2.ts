/**
 * lib/portfolio/v2.ts — portfolio rows for the NEW deployment.
 *
 * The v2 indexer's owner-scoped endpoints exist but return no rows on testnet
 * yet, and there is no summary/history endpoint at all. So the portfolio screen
 * runs on TWO sources behind one normalized shape:
 *
 *  - `normalizeV2Position` maps a real `/accounts/{owner}/positions` row (field
 *    names best-effort — see V2Position) into a display row. Used automatically
 *    the moment the endpoint starts reporting.
 *  - `demoPositions` / `demoHistory` provide clearly-marked SAMPLE rows so the
 *    screen shows its full design today. Flip `V2_DEMO_ENABLED` off (or just
 *    let real rows arrive — they always win) once the indexer is live.
 */
import { fromQuote, toFloat } from '@/config/scale';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import type { V2Position } from '@/lib/api/v2/types';
import type { PastPrediction } from './history';

/** Master switch for the sample dataset. Real indexer rows always take priority. */
export const V2_DEMO_ENABLED = true;

export type V2Direction = 'Up' | 'Down' | 'Range';

/** One position as the portfolio renders it — real or sample. */
export interface V2PortfolioPosition {
  key: string;
  /** Underlying symbol when known (sample rows always; real rows once the
   *  market→underlying join is wired). */
  underlying?: string;
  direction: V2Direction;
  /** Binary strike (float $). */
  strike?: number;
  /** Range band (float $) — renders instead of strike. */
  band?: { lower: number; higher: number };
  expiry?: number; // ms
  /** Max payout if it resolves in your favor (DUSDC). */
  qty: number;
  cost?: number; // DUSDC staked
  entryPrice?: number; // 0..1 implied
  markPrice?: number; // 0..1 implied
  markValue?: number; // DUSDC
  pnl?: number; // DUSDC, signed
  settled: boolean;
  won?: boolean;
  /** True for illustrative rows — the card shows a Sample chip and disables actions. */
  sample?: boolean;
  /** Implied-probability series entry→now for the sparkline. */
  spark?: number[];
  /* Real rows only — everything redeem needs. */
  marketId?: string;
  orderId?: bigint;
  qtyBase?: bigint;
}

/* ────────────────────────────── real rows ────────────────────────────── */

/** Direction from the tick pair: [x, +inf) = Up, [0, x) = Down, else Range. */
function tickDirection(p: V2Position): V2Direction {
  const lo = p.lower_tick != null ? BigInt(p.lower_tick) : 0n;
  const hi = p.higher_tick != null ? BigInt(p.higher_tick) : 0n;
  if (hi === POS_INF_TICK) return 'Up';
  if (lo === 0n && hi !== 0n) return 'Down';
  return 'Range';
}

function isSettledStatus(status: unknown): boolean {
  return /settl|redeem|won|lost|expired/i.test(String(status ?? ''));
}

/**
 * A real indexer row → display row. Reads are defensive: the endpoint returns
 * 200-empty on testnet, so field mapping is unconfirmed until populated —
 * anything missing renders as "—" rather than a guessed number.
 */
export function normalizeV2Position(p: V2Position, index: number): V2PortfolioPosition {
  const marketId = (p.expiry_market_id ?? p.market_id) as string | undefined;
  const direction = tickDirection(p);
  const qtyBase = BigInt(Math.round(Number(p.open_quantity ?? p.quantity ?? 0)));
  const cost = p.cost ?? p.total_cost;
  const lo = p.lower_tick != null ? toFloat(p.lower_tick) : undefined;
  const hi = p.higher_tick != null ? toFloat(p.higher_tick) : undefined;
  return {
    key: `${marketId ?? 'm'}-${p.order_id ?? index}`,
    direction,
    strike: direction === 'Up' ? lo : direction === 'Down' ? hi : undefined,
    band: direction === 'Range' && lo != null && hi != null ? { lower: lo, higher: hi } : undefined,
    expiry: p.expiry,
    qty: fromQuote(qtyBase),
    cost: cost != null ? fromQuote(cost) : undefined,
    markValue: p.mark_value != null ? fromQuote(p.mark_value) : undefined,
    pnl: p.pnl != null ? fromQuote(p.pnl) : undefined,
    settled: isSettledStatus(p.status),
    marketId,
    orderId: p.order_id != null ? BigInt(p.order_id) : undefined,
    qtyBase,
  };
}

/* ───────────────────────────── sample rows ───────────────────────────── */

const H = 3_600_000;
const D = 24 * H;

/** Open + claimable sample positions, expiring relative to `now`. */
export function demoPositions(now: number): V2PortfolioPosition[] {
  return [
    {
      key: 'demo-btc-up',
      underlying: 'BTC',
      direction: 'Up',
      strike: 72_000,
      expiry: now + 2 * H + 6 * 60_000,
      qty: 120,
      cost: 45.6,
      entryPrice: 0.38,
      markPrice: 0.504,
      markValue: 60.48,
      pnl: 14.88,
      settled: false,
      sample: true,
      spark: [0.38, 0.365, 0.4, 0.435, 0.42, 0.47, 0.504],
    },
    {
      key: 'demo-eth-down',
      underlying: 'ETH',
      direction: 'Down',
      strike: 3_400,
      expiry: now + 47 * 60_000,
      qty: 80,
      cost: 41.6,
      entryPrice: 0.52,
      markPrice: 0.461,
      markValue: 36.88,
      pnl: -4.72,
      settled: false,
      sample: true,
      spark: [0.52, 0.53, 0.505, 0.49, 0.5, 0.472, 0.461],
    },
    {
      key: 'demo-sol-range',
      underlying: 'SOL',
      direction: 'Range',
      band: { lower: 165, higher: 180 },
      expiry: now + 5 * H + 20 * 60_000,
      qty: 150,
      cost: 58.5,
      entryPrice: 0.39,
      markPrice: 0.448,
      markValue: 67.2,
      pnl: 8.7,
      settled: false,
      sample: true,
      spark: [0.39, 0.41, 0.4, 0.425, 0.45, 0.44, 0.448],
    },
    {
      key: 'demo-btc-settled',
      underlying: 'BTC',
      direction: 'Up',
      strike: 68_500,
      expiry: now - 3 * H,
      qty: 100,
      cost: 62,
      entryPrice: 0.62,
      markPrice: 1,
      markValue: 100,
      pnl: 38,
      settled: true,
      won: true,
      sample: true,
      spark: [0.62, 0.66, 0.71, 0.68, 0.8, 0.93, 1],
    },
  ];
}

/** A settled sample trade → one history row (payout − cost = pnl). */
function demoTrade(
  now: number,
  daysAgo: number,
  underlying: string,
  up: boolean,
  strike: number,
  contracts: number,
  cost: number,
  payout: number,
  entryPrice: number,
  band?: { lower: number; higher: number },
): PastPrediction {
  const settledAt = now - daysAgo * D;
  const pnl = payout - cost;
  return {
    key: `demo-hist-${underlying}-${daysAgo}`,
    oracleId: '0xdemo',
    underlying,
    up,
    strike,
    band,
    expiry: settledAt,
    settledAt,
    result: pnl > 0 ? 'won' : 'lost',
    contracts,
    cost,
    payout,
    pnl,
    roi: cost > 0 ? pnl / cost : 0,
    entryPrice,
  };
}

/** Two weeks of illustrative settled trades (newest first). */
export function demoHistory(now: number): PastPrediction[] {
  return [
    demoTrade(now, 0.6, 'BTC', true, 70_500, 90, 40.5, 90, 0.45),
    demoTrade(now, 1.8, 'ETH', false, 3_550, 60, 33.6, 60, 0.56),
    demoTrade(now, 3.2, 'SOL', true, 172, 110, 52.8, 0, 0.48),
    demoTrade(now, 5.5, 'BTC', true, 0, 140, 47.6, 140, 0.34, { lower: 66_000, higher: 69_500 }),
    demoTrade(now, 7.1, 'ETH', true, 3_250, 75, 42, 75, 0.56),
    demoTrade(now, 9.4, 'BTC', false, 71_800, 50, 29, 0, 0.58),
    demoTrade(now, 12.3, 'SOL', true, 158, 95, 36.1, 95, 0.38),
  ];
}

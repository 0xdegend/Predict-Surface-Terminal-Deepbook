/**
 * lib/portfolio/v2.ts — portfolio rows for the NEW deployment.
 *
 * The v2 indexer's owner-scoped endpoints exist but return no rows on testnet
 * yet, and there is no summary/history endpoint at all. So the portfolio screen
 * runs on TWO sources behind one normalized shape:
 *
 *  - `normalizeV2Position` maps a real `/accounts/{account_id}/positions` row
 *    (verified live 2026-07-10) into a display row, joined to its market for the
 *    tick→price conversion (ticks are indices, not prices).
 *  - `demoPositions` / `demoHistory` provide clearly-marked SAMPLE rows so the
 *    screen shows its full design today. Flip `V2_DEMO_ENABLED` off (or just
 *    let real rows arrive — they always win) once the indexer is live.
 */
import { fromQuote, toFloat } from '@/config/scale';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import { upFair, rangeFair, type SviFloat } from '@/lib/svi/svi';
import type { V2Position, V2Market, V2OrderEvent } from '@/lib/api/v2/types';
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
  /** Net move since entry, in percentage points (markPrice − entryPrice). */
  deltaPp?: number;
  /* Real rows only — everything redeem + the metric tiles need. */
  marketId?: string;
  orderId?: bigint;
  qtyBase?: bigint;
  /** Static dollar floor (DUSDC) encoded in the order — drives leveraged MTM. */
  floorShares?: number;
  /** Leverage multiple (1 = none). */
  leverage?: number;
  /** When the position was opened (ms epoch). */
  openedAt?: number;
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
export function normalizeV2Position(
  p: V2Position,
  index: number,
  market?: V2Market,
): V2PortfolioPosition {
  const marketId = (p.expiry_market_id ?? p.market_id) as string | undefined;
  const direction = tickDirection(p);
  const qtyBase = BigInt(Math.round(Number(p.open_quantity ?? p.quantity ?? 0)));
  // net_premium is what the trader staked (before fees); it's the closest the
  // indexer gives to "cost" (no cost/total_cost field on the real row).
  const costBase = p.cost ?? p.total_cost ?? (p as { net_premium?: string | number }).net_premium;
  // Ticks are grid INDICES — the strike price is `tick × tick_size`. Without the
  // market we can't convert, so leave strike/band undefined rather than show a
  // nonsense number.
  const tickSize = market ? toFloat(market.tick_size) : undefined;
  const priceOf = (tick?: string | number) =>
    tick != null && tickSize != null ? Number(tick) * tickSize : undefined;
  const lo = priceOf(p.lower_tick);
  const hi = priceOf(p.higher_tick);
  const r = p as {
    entry_probability?: string | number;
    floor_shares?: string | number;
    leverage?: string | number;
    opened_at_ms?: number;
  };
  const entryProbRaw = r.entry_probability;
  return {
    key: `${marketId ?? 'm'}-${p.order_id ?? index}`,
    // v2 markets are BTC_USD today; wire from the market's underlying id when
    // more assets ship (the row/market carry propbook_underlying_id).
    underlying: 'BTC',
    direction,
    strike: direction === 'Up' ? lo : direction === 'Down' ? hi : undefined,
    band: direction === 'Range' && lo != null && hi != null ? { lower: lo, higher: hi } : undefined,
    expiry: p.expiry ?? (market ? Number(market.expiry) : undefined),
    qty: fromQuote(qtyBase),
    cost: costBase != null ? fromQuote(costBase) : undefined,
    entryPrice: entryProbRaw != null ? toFloat(entryProbRaw) : undefined,
    markValue: p.mark_value != null ? fromQuote(p.mark_value) : undefined,
    pnl: p.pnl != null ? fromQuote(p.pnl) : undefined,
    settled: isSettledStatus(p.status),
    won: isSettledStatus(p.status) ? wonFromStatus(p.status) : undefined,
    marketId,
    orderId: p.order_id != null ? BigInt(p.order_id) : undefined,
    qtyBase,
    floorShares: r.floor_shares != null ? fromQuote(r.floor_shares) : undefined,
    leverage: r.leverage != null ? toFloat(r.leverage) : undefined,
    openedAt: r.opened_at_ms,
  };
}

/** A settled bet won unless the status is an explicit loss/knockout. */
function wonFromStatus(status: unknown): boolean {
  const s = String(status ?? '');
  if (/lost|liquidat|knock|expired|worthless/i.test(s)) return false;
  return /redeem|settl|won|paid/i.test(s);
}

const n = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * Trade history from the account's order EVENT log (`/accounts/{id}/orders`) —
 * the authoritative, append-only record. Each `*_redeemed` event is one realized
 * close, joined to its `order_minted` by `position_root_id` for the cost basis,
 * side and strike. Verified against the Move event structs (order_events.move):
 *  - settled_order_redeemed   → payout = payout_amount (terminal)
 *  - live_order_redeemed      → payout = redeem_amount − trading/builder/penalty fees
 *  - liquidated_order_redeemed→ payout = 0 (knocked out, full loss)
 * Cost basis is the mint's net_premium, prorated by the closed fraction (partial
 * closes each become their own row). Newest first.
 */
export function deriveV2HistoryFromOrders(
  orders: V2OrderEvent[],
  marketMap?: Map<string, V2Market>,
): PastPrediction[] {
  const mints = new Map<string, V2OrderEvent>();
  for (const o of orders) {
    if (o.kind === 'order_minted' && o.position_root_id != null) {
      mints.set(String(o.position_root_id), o);
    }
  }

  const rows: PastPrediction[] = [];
  for (const o of orders) {
    const kind = String(o.kind ?? '');
    if (!/redeemed/i.test(kind)) continue; // live_/settled_/liquidated_order_redeemed
    const mint = o.position_root_id != null ? mints.get(String(o.position_root_id)) : undefined;

    const market = o.expiry_market_id ? marketMap?.get(o.expiry_market_id) : undefined;
    const tickSize = market ? toFloat(market.tick_size) : undefined;
    const lowerTick = mint?.lower_tick ?? o.lower_tick;
    const higherTick = mint?.higher_tick ?? o.higher_tick;
    const direction = tickDirection({ lower_tick: lowerTick, higher_tick: higherTick } as V2Position);
    const priceOf = (t?: string | number) => (t != null && tickSize != null ? Number(t) * tickSize : undefined);
    const lo = priceOf(lowerTick);
    const hi = priceOf(higherTick);

    const totalQty = n(mint?.quantity) || n(o.quantity_closed);
    const closed = n(o.quantity_closed) || totalQty;
    const frac = totalQty > 0 ? closed / totalQty : 1;
    const cost = fromQuote(n(mint?.net_premium) * frac);

    const settled = /settled/i.test(kind);
    const liquidated = /liquidat/i.test(kind);
    const fees = settled ? 0 : n(o.trading_fee) + n(o.builder_fee) + n(o.penalty_fee);
    const gross = liquidated ? 0 : fromQuote(settled ? n(o.payout_amount) : n(o.redeem_amount));
    const payout = Math.max(0, gross - fromQuote(fees));
    const pnl = payout - cost;

    rows.push({
      key: `${o.expiry_market_id ?? 'm'}-${o.order_id ?? o.position_root_id}-${o.checkpoint_timestamp_ms ?? ''}`,
      oracleId: o.expiry_market_id ?? '',
      underlying: 'BTC',
      up: direction !== 'Down',
      strike: direction === 'Up' ? lo ?? 0 : direction === 'Down' ? hi ?? 0 : 0,
      band: direction === 'Range' && lo != null && hi != null ? { lower: lo, higher: hi } : undefined,
      expiry: market ? Number(market.expiry) : (o.checkpoint_timestamp_ms ?? 0),
      settledAt: o.checkpoint_timestamp_ms ?? 0,
      result: pnl > 0 ? 'won' : 'lost',
      contracts: fromQuote(closed),
      cost,
      payout,
      pnl,
      roi: cost > 0 ? pnl / cost : 0,
      entryPrice: mint?.entry_probability != null ? toFloat(mint.entry_probability) : 0,
      leverage: mint?.leverage != null ? toFloat(mint.leverage) : undefined,
    });
  }

  return rows.sort((a, b) => b.settledAt - a.settledAt);
}

/**
 * Mark a LIVE position off the current pricer — the v2 indexer reports no
 * mark/PnL, so we compute it client-side (the same numbers legacy got from the
 * server). Value = what closing would pay ≈ `max(0, p_now·qty − floor_shares)`
 * (equity above the static floor; a knocked-out leverage bet pays 0), so at
 * entry value = net_premium and PnL = 0. PnL = value − cost, net move = the
 * probability change in points. Returns a NEW enriched row (or the row unchanged
 * when there's no pricer / it's already settled).
 */
/** The position's current direction-fair chance off a live pricer (0..1), or null. */
export function positionMarkPrice(
  p: V2PortfolioPosition,
  pricer: { forward: number; svi: SviFloat } | undefined,
): number | null {
  if (!pricer) return null;
  if (p.direction === 'Range') {
    return p.band ? rangeFair(p.band.lower, p.band.higher, pricer.forward, pricer.svi) : null;
  }
  if (p.strike == null) return null;
  const up = upFair(p.strike, pricer.forward, pricer.svi);
  return p.direction === 'Down' ? 1 - up : up;
}

/** One decoded spot observation (oldest→newest by `t`). */
export interface SpotPoint {
  t: number; // ms epoch
  s: number; // spot price (float)
}

/**
 * The position's implied-probability path over the recent window — an honest
 * sparkline (a binary's price IS its probability, so this is its value path).
 *
 * Reconstructed from real Pyth spot history priced through the CURRENT vol
 * surface (sticky-SVI): each historical spot is scaled to a forward by the live
 * forward/spot basis, then run through the position's own strike/band. Over the
 * short v2 tenors SVI barely moves, so this tracks the true path closely.
 *
 * TODO(exact): when the propbook per-oracle Block-Scholes/SVI history endpoint
 * (`/oracles/:id/block-scholes`, committed but not yet deployed — see the
 * ENDPOINT AUDIT) ships, price each historical forward through its OWN SVI
 * snapshot instead of `pricer.svi`. That's the only change — swap the `svi`
 * argument below for the time-matched historical one.
 */
export function buildV2Spark(
  p: V2PortfolioPosition,
  pricer: { forward: number; svi: SviFloat } | undefined,
  spots: SpotPoint[] | undefined,
): number[] {
  if (p.settled || !pricer || !spots || spots.length < 2) return [];
  const asc = [...spots].sort((a, b) => a.t - b.t);
  const spotNow = asc[asc.length - 1].s;
  const basis = spotNow > 0 ? pricer.forward / spotNow : 1;
  const path: { t: number; v: number }[] = [];
  for (const d of asc) {
    const v = positionMarkPrice(p, { forward: d.s * basis, svi: pricer.svi });
    if (v != null) path.push({ t: d.t, v });
  }
  if (path.length < 2) return [];
  // Prefer the holding window; fall back to the full window if it's too thin.
  const held = p.openedAt != null ? path.filter((d) => d.t >= p.openedAt!) : path;
  return (held.length >= 4 ? held : path).map((d) => d.v);
}

export function valueV2Position(
  p: V2PortfolioPosition,
  markPrice: number | null,
): V2PortfolioPosition {
  if (p.settled || markPrice == null) return p;
  const floor = p.floorShares ?? 0;
  const markValue = Math.max(0, markPrice * p.qty - floor);
  const pnl = p.cost != null ? markValue - p.cost : undefined;
  const deltaPp = p.entryPrice != null ? (markPrice - p.entryPrice) * 100 : undefined;
  return { ...p, markPrice, markValue, pnl, deltaPp };
}

// SVI is irrelevant once a settlement price is passed to upFair/rangeFair (they
// short-circuit to the exact 1/0 payoff), so any params work — a zero smile.
const SETTLED_SVI: SviFloat = { a: 0, b: 0, rho: 0, m: 0, sigma: 0 };

/**
 * Resolve an EXPIRED position from its market's on-chain settlement price — the
 * same 1/0 payoff the surface math uses (upFair/rangeFair with a `settlement`).
 *
 * Why this is needed: the v2 indexer is slow to flip a position to a terminal
 * status, and the live pricer stops quoting the moment a market expires. Without
 * this, an expired bet sits on "settling" with a blank mark/PnL indefinitely and
 * the trader never learns whether it won or lost. Given the settlement price we
 * can decide the outcome ourselves — deterministic, no pricer required.
 *
 * Returns the row flipped to settled + won with the realized payout/PnL, or the
 * row unchanged when the market hasn't settled yet (or we can't price it).
 */
export function settleV2Position(
  p: V2PortfolioPosition,
  settlement: number | null | undefined,
): V2PortfolioPosition {
  if (p.settled || settlement == null) return p;
  // Direction-fair outcome at settlement: 1 = in the money, 0 = out.
  let outcome: number | null = null;
  if (p.direction === 'Range' && p.band) {
    outcome = rangeFair(p.band.lower, p.band.higher, 0, SETTLED_SVI, settlement);
  } else if (p.strike != null) {
    const up = upFair(p.strike, 0, SETTLED_SVI, settlement);
    outcome = p.direction === 'Down' ? 1 - up : up;
  }
  if (outcome == null) return p;
  const won = outcome >= 0.5;
  // Each contract pays 1.00 on a win; a loss (or knocked-out leverage) pays 0.
  // The real terminal payout takes over once the indexer reports the redeem.
  const markValue = won ? p.qty : 0;
  const pnl = p.cost != null ? markValue - p.cost : undefined;
  const deltaPp = p.entryPrice != null ? (outcome - p.entryPrice) * 100 : undefined;
  return { ...p, settled: true, won, markPrice: outcome, markValue, pnl, deltaPp };
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
    {
      // A settled loser — the market resolved against the bet, so it paid
      // nothing. Included so the sample portfolio shows a plain "Lost" verdict
      // alongside the win, and demonstrates the Clear action.
      key: 'demo-eth-settled-lost',
      underlying: 'ETH',
      direction: 'Up',
      strike: 3_600,
      expiry: now - 5 * H,
      qty: 90,
      cost: 39.6,
      entryPrice: 0.44,
      markPrice: 0,
      markValue: 0,
      pnl: -39.6,
      settled: true,
      won: false,
      sample: true,
      spark: [0.44, 0.42, 0.39, 0.33, 0.25, 0.12, 0],
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

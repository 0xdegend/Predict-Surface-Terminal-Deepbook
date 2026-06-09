/**
 * lib/ranges/aggregate.ts — fold a manager's range event streams into open
 * range positions. The server exposes no open-range summary, so we group
 * RangeMinted/RangeRedeemed by RangeKey (oracle:expiry:lower:higher) and net the
 * quantities — mirroring lib/leaderboard/aggregate.ts.
 *
 * SCALING: quantity / cost / payout are @6dec; strikes / prices @1e9. Values
 * stay in base units here; de-scale at the display edge (fromQuote / toFloat).
 */
import type { RangeMintedEvent, RangeRedeemedEvent } from '@/lib/api/types';

export interface RangePosition {
  oracleId: string;
  expiry: number; // ms
  lowerStrike: number; // @1e9
  higherStrike: number; // @1e9
  mintedQty: number; // @6dec
  redeemedQty: number; // @6dec
  openQty: number; // @6dec
  totalCost: number; // @6dec — all mints
  totalPayout: number; // @6dec — all redeems
  openCostBasis: number; // @6dec — cost attributable to the still-open qty (pro-rata)
  avgEntryPrice: number; // @1e9 per-unit, qty-weighted
  realizedPnl: number; // @6dec — payout − cost of the redeemed portion
  settled: boolean; // any redeem marked settled
  firstMintedAt: number; // ms
  lastActivityAt: number; // ms
}

function keyOf(e: {
  oracle_id: string;
  expiry: number;
  lower_strike: number;
  higher_strike: number;
}): string {
  return `${e.oracle_id}:${e.expiry}:${e.lower_strike}:${e.higher_strike}`;
}

interface Acc {
  oracleId: string;
  expiry: number;
  lowerStrike: number;
  higherStrike: number;
  mintedQty: number;
  redeemedQty: number;
  totalCost: number;
  totalPayout: number;
  askQtyWeighted: number; // Σ ask_price·qty, for a qty-weighted avg entry
  settled: boolean;
  firstMintedAt: number;
  lastActivityAt: number;
}

/** Fold minted/redeemed events into per-RangeKey open positions, open first. */
export function aggregateRangePositions(
  minted: RangeMintedEvent[],
  redeemed: RangeRedeemedEvent[],
): RangePosition[] {
  const acc = new Map<string, Acc>();
  const ensure = (e: RangeMintedEvent | RangeRedeemedEvent): Acc => {
    const k = keyOf(e);
    let a = acc.get(k);
    if (!a) {
      a = {
        oracleId: e.oracle_id,
        expiry: e.expiry,
        lowerStrike: e.lower_strike,
        higherStrike: e.higher_strike,
        mintedQty: 0,
        redeemedQty: 0,
        totalCost: 0,
        totalPayout: 0,
        askQtyWeighted: 0,
        settled: false,
        firstMintedAt: Infinity,
        lastActivityAt: 0,
      };
      acc.set(k, a);
    }
    return a;
  };

  for (const m of minted) {
    const a = ensure(m);
    a.mintedQty += m.quantity;
    a.totalCost += m.cost;
    a.askQtyWeighted += m.ask_price * m.quantity;
    a.firstMintedAt = Math.min(a.firstMintedAt, m.checkpoint_timestamp_ms);
    a.lastActivityAt = Math.max(a.lastActivityAt, m.checkpoint_timestamp_ms);
  }
  for (const r of redeemed) {
    const a = ensure(r);
    a.redeemedQty += r.quantity;
    a.totalPayout += r.payout;
    if (r.is_settled) a.settled = true;
    a.lastActivityAt = Math.max(a.lastActivityAt, r.checkpoint_timestamp_ms);
  }

  const out: RangePosition[] = [];
  for (const a of acc.values()) {
    const openQty = Math.max(0, a.mintedQty - a.redeemedQty);
    const openFrac = a.mintedQty > 0 ? openQty / a.mintedQty : 0;
    const openCostBasis = a.totalCost * openFrac;
    const redeemedCost = a.totalCost - openCostBasis;
    out.push({
      oracleId: a.oracleId,
      expiry: a.expiry,
      lowerStrike: a.lowerStrike,
      higherStrike: a.higherStrike,
      mintedQty: a.mintedQty,
      redeemedQty: a.redeemedQty,
      openQty,
      totalCost: a.totalCost,
      totalPayout: a.totalPayout,
      openCostBasis,
      avgEntryPrice: a.mintedQty > 0 ? a.askQtyWeighted / a.mintedQty : 0,
      realizedPnl: a.totalPayout - redeemedCost,
      settled: a.settled,
      firstMintedAt: a.firstMintedAt === Infinity ? a.lastActivityAt : a.firstMintedAt,
      lastActivityAt: a.lastActivityAt,
    });
  }
  // Open positions first (largest open qty), then most recently active.
  return out.sort((x, y) => y.openQty - x.openQty || y.lastActivityAt - x.lastActivityAt);
}

export interface RangeValuation {
  fairUp: number; // current range fair probability in [0,1]
  currentValue: number; // @6dec — fairUp × openQty
  unrealizedPnl: number; // @6dec — currentValue − openCostBasis
  totalPnl: number; // @6dec — realized + unrealized
}

/**
 * Value an open range with a live fair probability (computed from the oracle's
 * latest SVI via `rangeFair`). For a settled oracle the caller passes the
 * realized outcome (1 if settlement landed in the band, else 0).
 */
export function valueRange(pos: RangePosition, fairUp: number): RangeValuation {
  const f = Math.max(0, Math.min(1, fairUp));
  const currentValue = f * pos.openQty; // $1 = 1e6 = (fair 1.0 × 1 contract)
  const unrealizedPnl = currentValue - pos.openCostBasis;
  return { fairUp: f, currentValue, unrealizedPnl, totalPnl: pos.realizedPnl + unrealizedPnl };
}

/**
 * Pure display-metric derivation for a PositionSummary. One place so the rail,
 * the card, and the redeem modal all read identical, correctly-scaled numbers.
 *
 * Server scales: quantities/costs/pnl/value are @6dec (base units); prices
 * (entry/mark) are @1e9. We de-scale here and never elsewhere.
 */
import { fromQuote, toFloat } from '@/config/scale';
import type { PositionSummary } from '@/lib/api/types';

export interface PositionMetrics {
  contracts: number; // human contract count (each pays 1.00 if it wins)
  maxPayout: number; // = contracts
  cost: number; // DUSDC paid (cost basis of the open lot)
  value: number | null; // current mark value in DUSDC
  pnl: number; // unrealized PnL in DUSDC (signed)
  pnlPct: number; // PnL / cost basis (signed ratio)
  entryPrice: number; // avg per-unit entry (0..1)
  markPrice: number | null; // current per-unit mark (0..1)
  isSettled: boolean; // settled or awaiting settlement → redeem is final
}

export function positionMetrics(p: PositionSummary): PositionMetrics {
  const contracts = fromQuote(p.open_quantity);
  const cost = fromQuote(p.open_cost_basis || p.total_cost);
  const value = p.mark_value != null ? fromQuote(p.mark_value) : null;
  const pnl = fromQuote(p.unrealized_pnl);
  const basis = p.open_cost_basis || p.total_cost; // base units; ratio is scale-free
  return {
    contracts,
    maxPayout: contracts,
    cost,
    value,
    pnl,
    pnlPct: basis > 0 ? p.unrealized_pnl / basis : 0,
    entryPrice: toFloat(p.average_entry_price),
    markPrice: p.mark_price != null ? toFloat(p.mark_price) : null,
    isSettled: p.status === 'settled' || p.status === 'awaiting_settlement',
  };
}

/** Human label for a position status. */
export function statusLabel(status: PositionSummary['status']): string {
  switch (status) {
    case 'active':
    case 'open':
      return 'open';
    case 'awaiting_settlement':
      return 'awaiting settlement';
    case 'settled':
      return 'settled';
    case 'redeemed':
      return 'redeemed';
    default:
      return String(status);
  }
}

/**
 * The point of these tests is the SILENT failure, not the loud one.
 *
 * Every field 8-21 renamed is read by name and funnelled through `Number(x ?? 0)`, so the
 * unpatched app does not throw, log, or render an error on the new deployment. It renders a
 * complete, confident, entirely wrong leaderboard where every trader staked $0. So the
 * assertions below are mostly of the form "this number is not zero", which is a weak-looking
 * test guarding the exact way this breaks.
 *
 * The payloads are the real field sets from the live package ABIs, read on 2026-08-31 (see
 * lib/sui/v2/abi-drift.live.test.ts) — not invented shapes.
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeOrderEvent,
  normalizeMarketCreated,
  oracleReadTimestamp,
  isFullSettledClose,
  UNIT_LEVERAGE,
} from './event-compat';
import { aggregateV2Leaderboard } from '@/lib/leaderboard/v2-aggregate';
import type { V2OrderEvent } from './types';

const NOW = 1_756_000_000_000;
const CODE = '0xc0de';

/** Normalize and attach the `kind` + indexer stamp the production call sites add. */
const asEvent = (raw: Record<string, unknown>, kind = 'order_minted'): V2OrderEvent =>
  ({ ...normalizeOrderEvent(raw, kind), kind, checkpoint_timestamp_ms: NOW }) as unknown as V2OrderEvent;

/** An `OrderMinted` exactly as 8-21 emits it: `premium`, no `leverage`, one shared stamp. */
const minted821 = {
  expiry_market_id: '0xm1',
  account_id: '0xa1',
  order_id: '7',
  position_root_id: 'root-1',
  owner: '0xowner',
  lower_tick: 6_300_000,
  higher_tick: '340282366920938463463374607431768211455',
  entry_probability: 500_000_000,
  quantity: '10000000',
  premium: '5000000', // $5 staked — the field 8-06 called net_premium
  trading_fee: '10000',
  builder_code_id: CODE,
  onchain_timestamp_ms: NOW,
};

/** The same trade as 8-06 emits it. */
const minted806 = {
  ...minted821,
  net_premium: '5000000',
  leverage: 2_000_000_000,
  minted_at_ms: NOW,
  premium: undefined,
  onchain_timestamp_ms: undefined,
};

describe('normalizeOrderEvent', () => {
  it('recovers the stake from the renamed field', () => {
    // The single most damaging rename in the release: without this every money figure in
    // the app — points, volume, cost basis, PnL — reads as 0 while looking healthy.
    const out = normalizeOrderEvent(minted821, 'order_minted');
    expect(out.net_premium).toBe('5000000');
  });

  it('never overwrites a stake that is already there', () => {
    const out = normalizeOrderEvent({ ...minted821, net_premium: '9' }, 'order_minted');
    expect(out.net_premium).toBe('9');
  });

  it('leaves an 8-06 payload completely alone apart from the leverage default', () => {
    // Running on the old deployment must be byte-identical to today, or the migration
    // itself becomes the thing that breaks production.
    const out = normalizeOrderEvent(minted806, 'order_minted');
    expect(out.net_premium).toBe('5000000');
    expect(out.minted_at_ms).toBe(NOW);
    expect(out.leverage).toBe(2_000_000_000);
  });

  it('routes the shared timestamp to the field each event kind is read by', () => {
    expect(normalizeOrderEvent(minted821, 'order_minted').minted_at_ms).toBe(NOW);
    const redeem = { position_root_id: 'root-1', payout_amount: '9', onchain_timestamp_ms: NOW };
    expect(normalizeOrderEvent(redeem, 'settled_order_redeemed').redeemed_at_ms).toBe(NOW);
    expect(normalizeOrderEvent(redeem, 'live_order_redeemed').redeemed_at_ms).toBe(NOW);
  });

  it('presents an 8-21 position as 1x rather than as leverage-less', () => {
    // Downstream multiplies by leverage. Absent would give NaN, 0 would give 0; 1x makes
    // the same arithmetic an identity on a protocol that no longer has the concept.
    expect(normalizeOrderEvent(minted821, 'order_minted').leverage).toBe(UNIT_LEVERAGE);
  });

  it('does not invent a quantity for a settled claim that has none', () => {
    // Consumers read `n(quantity_closed) || totalQty`, which already resolves an absent
    // quantity to the full position — the 8-21 all-or-nothing semantic. A number filled in
    // here would replace that correct fallback with a guess.
    const out = normalizeOrderEvent({ position_root_id: 'r', payout_amount: '9' }, 'settled_order_redeemed');
    expect(out.quantity_closed).toBeUndefined();
  });
});

describe('the leaderboard on 8-21 payloads', () => {
  it('scores a real 8-21 mint at its actual stake, not at zero', () => {
    // End to end through the scorer the board actually uses. This is the test that would
    // have caught the whole class of failure: with the seam removed, `staked` is 0 and the
    // board still renders, ranked, with everybody on nothing.
    const rows = aggregateV2Leaderboard(new Map([['0xm1', [asEvent(minted821)]]]), CODE, NOW + 60_000);
    expect(rows).toHaveLength(1);
    expect(rows[0].volume).toBeGreaterThan(0);
    expect(rows[0].trades).toBe(1);
  });

  it('scores the same trade identically whichever deployment emitted it', () => {
    // The migration must not move a number on the board. Same trade, two wire formats.
    const a = aggregateV2Leaderboard(new Map([['0xm1', [asEvent(minted821)]]]), CODE, NOW + 60_000);
    const b = aggregateV2Leaderboard(new Map([['0xm1', [asEvent(minted806)]]]), CODE, NOW + 60_000);
    expect(a[0].volume).toBe(b[0].volume);
    expect(a[0].trades).toBe(b[0].trades);
  });
});

describe('normalizeMarketCreated', () => {
  it('fills the leverage knobs 8-21 removed with values that make the ticket a no-op', () => {
    // `toFloat(undefined)` is NaN, and NaN in the slider bounds is a broken ticket, so a
    // default is required rather than tidy. 1x + ltv 0 is the pair that makes
    // knockoutProbability and priceMoveToKnockout both return null — the no-barrier state
    // the ticket already renders correctly, with no UI change.
    const m = normalizeMarketCreated({ expiry_market_id: '0xm', tick_size: '10000000' });
    expect(m.max_admission_leverage).toBe(UNIT_LEVERAGE);
    expect(m.liquidation_ltv).toBe(0);
    expect(m.no_leverage_window_ms).toBe(0);
    expect(m.trading_loss_rebate_rate).toBe(0);
  });

  it('leaves a real 8-06 market untouched', () => {
    const m = normalizeMarketCreated({ max_admission_leverage: 3_000_000_000, liquidation_ltv: 850_000_000 });
    expect(m.max_admission_leverage).toBe(3_000_000_000);
    expect(m.liquidation_ltv).toBe(850_000_000);
  });
});

describe('oracleReadTimestamp', () => {
  it('reads the stamp under either name', () => {
    // This value is the chart's live edge and the input to the stale-feed banner. Losing it
    // does not blank the price; it makes a healthy feed look infinitely stale.
    expect(oracleReadTimestamp({ onchain_timestamp_ms: NOW })).toBe(NOW);
    expect(oracleReadTimestamp({ update_timestamp_ms: NOW })).toBe(NOW);
    expect(oracleReadTimestamp({})).toBe(0);
  });
});

describe('isFullSettledClose', () => {
  it('only treats a quantity-less SETTLED redeem as a full close', () => {
    expect(isFullSettledClose('settled_order_redeemed', undefined)).toBe(true);
    expect(isFullSettledClose('settled_order_redeemed', '5000')).toBe(false);
    // A live redeem is genuinely partial and must keep subtracting its own quantity.
    expect(isFullSettledClose('live_order_redeemed', undefined)).toBe(false);
    expect(isFullSettledClose('order_minted', undefined)).toBe(false);
  });
});

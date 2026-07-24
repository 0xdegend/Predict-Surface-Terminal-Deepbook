import { describe, it, expect } from 'vitest';
import { startFlow, advanceFlow, extractSlots, type FlowContext } from './flow';
import type { SviFloat } from '@/lib/svi/svi';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const NOW = 1_700_000_000_000;

function candidate(id: string, expiryMs: number, forward = 65_000) {
  const market = {
    expiry_market_id: id,
    expiry: expiryMs,
    admission_tick_size: '1000000000',
    min_entry_probability: '10000000', // 0.01
    max_entry_probability: '990000000', // 0.99
    max_admission_leverage: 3_000_000_000, // 3.0
  } as unknown as V2Market;
  const pricer: LivePricer = { expiryMarketId: id, forward, svi: SVI };
  return { market, pricer };
}

// One market with plenty of runway (7 min out).
const ctx: FlowContext = { candidates: [candidate('m1', NOW + 7 * 60_000)], now: NOW };

describe('trade wizard — happy path', () => {
  it('walks strike → direction → amount → leverage → review', () => {
    const s0 = startFlow(ctx);
    expect(s0.flow?.step).toBe('strike');

    const s1 = advanceFlow(s0.flow!, '65,000', ctx);
    expect(s1.flow?.step).toBe('direction');
    expect(s1.flow?.strikePrice).toBeCloseTo(65_000, -1);

    const s2 = advanceFlow(s1.flow!, 'below', ctx);
    expect(s2.flow?.step).toBe('amount');
    expect(s2.flow?.isUp).toBe(false);

    const s3 = advanceFlow(s2.flow!, '10 dusdc', ctx);
    expect(s3.flow?.step).toBe('leverage');
    expect(s3.flow?.amount).toBe(10);
    expect(s3.reply.text.join(' ')).toMatch(/leverage/i);

    const s4 = advanceFlow(s3.flow!, '1', ctx);
    expect(s4.flow?.step).toBe('review');
    expect(s4.reply.bet).toBeDefined();
    const b = s4.reply.bet!;
    expect(b.amount).toBe(10);
    expect(b.leverage).toBe(1);
    expect(b.isUp).toBe(false);
    expect(b.payoutMult).toBeGreaterThan(1);
  });
});

describe('trade wizard — current price', () => {
  it('quotes the live spot (matching the tape), not the forward', () => {
    // forward 65,000, tape spot 64,900 → the wizard must show 64,900.
    const c = candidate('m1', NOW + 7 * 60_000, 65_000);
    const s = startFlow({ candidates: [c], now: NOW, spot: 64_900 });
    const blob = s.reply.text.join(' ');
    expect(blob).toContain('64,900');
    expect(blob).not.toContain('65,000');
  });

  it('still snaps/prices the strike on the forward (spot is display-only)', () => {
    const c = candidate('m1', NOW + 7 * 60_000, 65_000);
    const ctx2: FlowContext = { candidates: [c], now: NOW, spot: 64_900 };
    // Type a strike; the snapped strike + odds come off the forward, unaffected by spot.
    const s = advanceFlow({ step: 'strike', marketId: 'm1' }, '65,000', ctx2);
    expect(s.flow?.step).toBe('direction');
    expect(s.flow?.strikePrice).toBeCloseTo(65_000, -1);
  });
});

describe('trade wizard — one-shot slot filling', () => {
  it('extractSlots reads strike, leverage, and amount from one message', () => {
    const s = extractSlots('Set up my trade for me, strike 66,000, leverage 2x, bet amount 6 dusdc');
    expect(s.strikePrice).toBe(66_000);
    expect(s.leverage).toBe(2);
    expect(s.amount).toBe(6);
    expect(s.isUp).toBeUndefined(); // "set up" must NOT read as UP
  });

  it('extractSlots reads an explicit direction', () => {
    expect(extractSlots('bet strike 65000 above, 2x, 5 dusdc').isUp).toBe(true);
    expect(extractSlots('strike 65000 below with 3x and 10 dusdc').isUp).toBe(false);
  });

  it('extractSlots reads a strike when the keyword comes AFTER the number', () => {
    // The exact phrasing that slipped through: "pick 64,850 as my strike".
    const s = extractSlots('Set up a trade for me, pick 64,850 as my strike, 2x leverage, will be betting with 10 dusdc');
    expect(s.strikePrice).toBe(64_850);
    expect(s.leverage).toBe(2);
    expect(s.amount).toBe(10);
    // "66k target" / "65000 price" (number-first) also read.
    expect(extractSlots('66k target, 2x, 5 dusdc').strikePrice).toBe(66_000);
    expect(extractSlots('go 64500 as the strike').strikePrice).toBe(64_500);
  });

  it('pre-fills every given slot and asks only for the missing one (direction)', () => {
    const s = startFlow(ctx, 'set up my trade, strike 65000, 2x leverage, bet 6 dusdc');
    expect(s.flow?.step).toBe('direction'); // the only thing missing
    expect(s.flow?.strikePrice).toBeCloseTo(65_000, -1);
    expect(s.flow?.amount).toBe(6);
    expect(s.flow?.leverage).toBe(2); // stored raw; capped at review
    expect(s.reply.text.join(' ')).toMatch(/above.*below|below.*above/i);

    // Answering the one missing slot jumps straight to review (no re-asking).
    const r = advanceFlow(s.flow!, 'above', ctx);
    expect(r.flow?.step).toBe('review');
    expect(r.reply.bet?.amount).toBe(6);
    expect(r.reply.bet?.isUp).toBe(true);
    expect(r.reply.bet?.leverage).toBeGreaterThanOrEqual(1);
    expect(r.reply.bet?.leverage).toBeLessThanOrEqual(2);
  });

  it('goes straight to review when the message gives everything', () => {
    const s = startFlow(ctx, 'set up a trade: strike 65000, above, 2x, 8 dusdc');
    expect(s.flow?.step).toBe('review');
    expect(s.reply.bet).toBeDefined();
    expect(s.reply.bet?.amount).toBe(8);
    expect(s.reply.bet?.isUp).toBe(true);
  });

  it('asks for the strike when only later slots are given', () => {
    const s = startFlow(ctx, 'set up a trade with 2x leverage and 6 dusdc');
    expect(s.flow?.step).toBe('strike');
    expect(s.flow?.leverage).toBe(2);
    expect(s.flow?.amount).toBe(6);
    expect(s.reply.text.join(' ')).toMatch(/what price|type a strike/i);
  });
});

describe('trade wizard — validation', () => {
  it('re-asks when the strike has no number', () => {
    const s = advanceFlow({ step: 'strike' }, 'hmm not sure', ctx);
    expect(s.flow?.step).toBe('strike');
    expect(s.reply.bet).toBeUndefined();
  });

  it('rejects a strike too far from price', () => {
    const s = advanceFlow({ step: 'strike' }, '100000', ctx); // ~0% to settle above
    expect(s.flow?.step).toBe('strike');
    expect(s.reply.text.join(' ')).toMatch(/too far/i);
  });

  it('enforces the minimum stake', () => {
    const s = advanceFlow({ step: 'amount', strikePrice: 65_000, isUp: true }, '0.5', ctx);
    expect(s.flow?.step).toBe('amount');
    expect(s.reply.text.join(' ')).toMatch(/smallest bet/i);
  });

  it('caps leverage above the strike max', () => {
    const s = advanceFlow({ step: 'leverage', strikePrice: 65_000, isUp: true, amount: 10 }, '999', ctx);
    expect(s.flow?.step).toBe('review');
    expect(s.reply.bet!.leverage).toBeLessThan(999);
    expect(s.reply.text.join(' ')).toMatch(/cap/i);
  });

  it('needs an explicit direction', () => {
    const s = advanceFlow({ step: 'direction', strikePrice: 65_000 }, 'maybe', ctx);
    expect(s.flow?.step).toBe('direction');
    expect(s.reply.text.join(' ')).toMatch(/above.*below|below.*above/i);
  });

  it('cancels on request', () => {
    const s = advanceFlow({ step: 'amount', strikePrice: 65_000, isUp: true }, 'never mind', ctx);
    expect(s.flow).toBeNull();
    expect(s.reply.text.join(' ')).toMatch(/cancel/i);
  });
});

describe('trade wizard — market runway', () => {
  it('starts on a market with runway, skipping one about to close', () => {
    const closing = candidate('m-soon', NOW + 15_000); // < 90s runway
    const fresh = candidate('m-later', NOW + 4 * 60_000); // ≥ 90s
    const s = startFlow({ candidates: [closing, fresh], now: NOW });
    expect(s.flow?.marketId).toBe('m-later');
  });

  it('hops to a fresher market mid-flow when the pinned one is about to close', () => {
    const closing = candidate('m-soon', NOW + 10_000); // 10s left, under the switch threshold
    const fresh = candidate('m-later', NOW + 5 * 60_000);
    const ctx2: FlowContext = { candidates: [closing, fresh], now: NOW };
    const s = advanceFlow({ step: 'direction', strikePrice: 65_000, marketId: 'm-soon' }, 'above', ctx2);
    expect(s.flow?.marketId).toBe('m-later'); // switched
    expect(s.flow?.step).toBe('amount'); // and still advances the step
    expect(s.reply.text.join(' ')).toMatch(/moved you to the next/i);
  });
});

describe('trade wizard — no market', () => {
  it("won't start without a live market", () => {
    const s = startFlow({ candidates: [], now: NOW });
    expect(s.flow).toBeNull();
    expect(s.reply.text.join(' ')).toMatch(/no live market/i);
  });
});

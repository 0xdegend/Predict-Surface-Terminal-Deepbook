import { describe, it, expect } from 'vitest';
import { planStrategyMints } from './strategy-mint';
import { leverageScaled, POS_INF_TICK, NEG_INF_TICK } from './ticks';
import { toQuote } from '@/config/scale';
import type { Leg } from '@/lib/strategy/strategy';
import type { SviFloat } from '@/lib/svi/svi';
import type { V2Market } from '@/lib/api/v2/types';

const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };
const FORWARD = 64_000;

const market = {
  expiry_market_id: 'm1',
  admission_tick_size: '1000000000', // $1 grid
  tick_size: '1',
  max_admission_leverage: 3_000_000_000,
  base_fee: '2000000', // 0.2%
  expiry: Date.now() + 2 * 3_600_000,
} as unknown as V2Market;

const up = (strike: number, stake = 10, id = 'u'): Leg => ({ id, kind: 'binary', strike, isUp: true, stake });
const dn = (strike: number, stake = 10, id = 'd'): Leg => ({ id, kind: 'binary', strike, isUp: false, stake });

describe('planStrategyMints', () => {
  it('plans one budget mint per leg, always at 1×', () => {
    const legs = [dn(62_000, 10, 'lo'), up(66_000, 10, 'hi')];
    const { plans } = planStrategyMints({ market, pricer: { forward: FORWARD, svi: SVI }, legs, balanceBase: 0n });
    expect(plans).toHaveLength(2);
    for (const p of plans) {
      expect(p.params.leverage).toBe(leverageScaled(1));
      expect(p.params.amount).toBeGreaterThan(0n);
      expect(p.params.minQuantity).toBeGreaterThan(0n);
      expect(p.stakeBase).toBe(toQuote(10));
      expect(p.estCostBase).toBeGreaterThan(p.stakeBase); // fee on top
    }
  });

  it('maps a binary UP to (strikeTick, +∞) and DOWN to (−∞, strikeTick)', () => {
    const legs = [up(66_000, 10, 'hi'), dn(62_000, 10, 'lo')];
    const { plans } = planStrategyMints({ market, pricer: { forward: FORWARD, svi: SVI }, legs, balanceBase: 0n });
    const upLeg = plans[0].params;
    const dnLeg = plans[1].params;
    expect(upLeg.higherTick).toBe(POS_INF_TICK);
    expect(dnLeg.lowerTick).toBe(NEG_INF_TICK);
  });

  it('a funded account deposits nothing; an empty one deposits every leg', () => {
    const legs = [up(64_000, 10, 'a'), up(64_500, 10, 'b')];
    const flush = planStrategyMints({ market, pricer: { forward: FORWARD, svi: SVI }, legs, balanceBase: 10_000_000_000n });
    expect(flush.totalDepositBase).toBe(0n);
    for (const p of flush.plans) expect(p.params.deposit).toBeUndefined();

    const broke = planStrategyMints({ market, pricer: { forward: FORWARD, svi: SVI }, legs, balanceBase: 0n });
    expect(broke.totalDepositBase).toBeGreaterThan(0n);
    for (const p of broke.plans) expect(p.params.deposit).toBeGreaterThan(0n);
  });

  it('the running deposit tops the wrapper up exactly once (partial balance)', () => {
    const legs = [up(64_000, 10, 'a'), up(64_500, 10, 'b'), up(65_000, 10, 'c')];
    // Enough for roughly the first leg only.
    const partial = planStrategyMints({ market, pricer: { forward: FORWARD, svi: SVI }, legs, balanceBase: toQuote(11) });
    // First leg's shortfall is covered by the balance; later legs deposit their own.
    expect(partial.plans[0].params.deposit).toBeUndefined();
    expect(partial.plans[2].params.deposit).toBeGreaterThan(0n);
    // Total deposit + starting balance is enough to cover the whole basket's cost.
    expect(partial.totalDepositBase + toQuote(11)).toBeGreaterThanOrEqual(partial.totalCostBase);
  });

  it('flags an out-of-band leg as not fully valid', () => {
    const legs = [up(90_000, 10, 'far')]; // ~0% for UP → not quotable
    const { allValid, plans } = planStrategyMints({ market, pricer: { forward: FORWARD, svi: SVI }, legs, balanceBase: 0n });
    expect(plans[0].probOk).toBe(false);
    expect(allValid).toBe(false);
  });

  it('flags a sub-$1 stake as not fully valid', () => {
    const legs = [up(64_000, 0.5, 'tiny')];
    const { allValid } = planStrategyMints({ market, pricer: { forward: FORWARD, svi: SVI }, legs, balanceBase: 0n });
    expect(allValid).toBe(false);
  });
});

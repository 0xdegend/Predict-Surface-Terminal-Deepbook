import { describe, it, expect } from 'vitest';
import { pickCandidate, type BetCandidate } from './respond';
import { MIN_TIME_TO_EXPIRY_MS } from '@/lib/autopilot/policy';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const NOW = 1_800_000_000_000;
const cand = (id: string, msLeft: number): BetCandidate =>
  ({ market: { expiry_market_id: id, expiry: NOW + msLeft } as V2Market, pricer: {} as LivePricer });

describe('pickCandidate: "soonest" skips a market about to settle', () => {
  it('prefers the soonest market that still has the floor worth of time', () => {
    const cs = [cand('5s', 5_000), cand('20s', 20_000), cand('90s', 90_000), cand('20m', 20 * 60_000)];
    expect(pickCandidate(cs, 'soonest', NOW)?.market.expiry_market_id).toBe('90s');
  });

  it('treats exactly the floor as enough', () => {
    const cs = [cand('5s', 5_000), cand('floor', MIN_TIME_TO_EXPIRY_MS)];
    expect(pickCandidate(cs, 'soonest', NOW)?.market.expiry_market_id).toBe('floor');
  });

  it('still answers with what exists when nothing has the floor (a person can read the time left)', () => {
    const cs = [cand('5s', 5_000), cand('20s', 20_000)];
    expect(pickCandidate(cs, 'soonest', NOW)?.market.expiry_market_id).toBe('5s');
  });

  it('leaves the hour horizon alone', () => {
    const cs = [cand('5s', 5_000), cand('58m', 58 * 60_000), cand('3h', 3 * 3_600_000)];
    expect(pickCandidate(cs, 'hour', NOW)?.market.expiry_market_id).toBe('58m');
  });

  it('ignores expired markets entirely', () => {
    expect(pickCandidate([cand('gone', -1_000)], 'soonest', NOW)).toBeNull();
  });
});

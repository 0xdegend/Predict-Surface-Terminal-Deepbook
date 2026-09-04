/**
 * What Kelly means by "today", now that the venue lists markets that settle next week.
 *
 * `pickCandidate` answered the "today" horizon with the LONGEST market it could price. That
 * was correct while every listed market settled within the hour: the longest one was still
 * this afternoon. On 8-21 it is not. Checked live on 2026-08-31 the venue had markets
 * settling in 0.3, 1.3, 2.3 and 9.3 days, so "give me a bet for today" would have returned
 * the nine-day market, and the ticket would have loaded it.
 *
 * The trade itself was always real and priced correctly. The problem is the sentence around
 * it: a trader who asked for today would have been shown a bet that resolves next week, and
 * agreed to it on the strength of the word.
 */
import { describe, it, expect } from 'vitest';
import { respondToIntent, type BetCandidate } from './respond';
import { TENOR_BUCKETS } from '@/lib/autopilot/policy';
import type { SviFloat } from '@/lib/svi/svi';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';

const NOW = 1_756_600_000_000;
const HOUR = 3_600_000;
const SVI: SviFloat = { a: 0.002, b: 0.01, rho: -0.1, m: 0, sigma: 0.08 };

function candidate(id: string, msOut: number): BetCandidate {
  const market = {
    expiry_market_id: id,
    expiry: NOW + msOut,
    admission_tick_size: '1000000000',
    tick_size: '1',
    max_admission_leverage: 1_000_000_000,
    base_fee: '0',
  } as unknown as V2Market;
  return { market, pricer: { expiryMarketId: id, forward: 65_000, svi: SVI } as LivePricer };
}

/** The live 8-21 board on the day this was written. */
const BOARD = [
  // A 1-minute market as it is when just listed: two minutes out. Anything under the
  // MIN_TIME_TO_EXPIRY_MS floor is no longer what "soonest" means (see pickCandidate).
  candidate('m-1m', 2 * 60_000),
  candidate('m-1h', HOUR),
  candidate('m-7h', 7.2 * HOUR), // a 1d market late in its life: genuinely today
  candidate('m-1d', 1.3 * 24 * HOUR),
  candidate('m-9d', 9.3 * 24 * HOUR), // the one that used to win
];

const ctx = (candidates: BetCandidate[]) => ({
  insights: null,
  candidates,
  now: NOW,
  spot: 65_000,
  closes: [],
  selection: null,
});

describe('Kelly answering "a bet for today"', () => {
  it('does not offer a market that settles next week', () => {
    const reply = respondToIntent(
      { kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'today' },
      ctx(BOARD),
    );
    expect(reply.bet, 'no bet was produced at all').toBeTruthy();
    const msOut = reply.bet!.expiry - NOW;
    expect(msOut, 'Kelly offered a market beyond today for a "today" request').toBeLessThanOrEqual(
      TENOR_BUCKETS.todayMaxMs,
    );
    expect(reply.bet!.marketId).not.toBe('m-9d');
  });

  it('still reaches for the longest window that really is today', () => {
    // The behaviour worth keeping: "today" should not collapse to the 1-minute market, or a
    // strike that needs hours to be reachable reads as hopeless.
    const reply = respondToIntent(
      { kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'today' },
      ctx(BOARD),
    );
    expect(reply.bet!.marketId).toBe('m-7h');
  });

  it('answers honestly when nothing settles today', () => {
    // Only long-dated markets listed. Rather than pick the furthest, take the soonest: the
    // copy always states the real time left, so the trader reads "3 days" and decides.
    const longOnly = [candidate('m-3d', 3 * 24 * HOUR), candidate('m-9d', 9.3 * 24 * HOUR)];
    const reply = respondToIntent(
      { kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'today' },
      ctx(longOnly),
    );
    expect(reply.bet!.marketId).toBe('m-3d');
    // And it must SAY days, not "223 hours".
    expect(reply.bet!.timeLeftLabel).toMatch(/day/);
  });

  it('leaves the short horizons exactly as they were', () => {
    const soon = respondToIntent(
      { kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'soonest' },
      ctx(BOARD),
    );
    expect(soon.bet!.marketId).toBe('m-1m');
    const hour = respondToIntent(
      { kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'hour' },
      ctx(BOARD),
    );
    expect(hour.bet!.marketId).toBe('m-1h');
  });
});

describe('Kelly answering "a bet for tomorrow" and "this week"', () => {
  it('a day out picks the 1-day market', () => {
    const reply = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'day' }, ctx(BOARD));
    expect(reply.bet?.marketId).toBe('m-1d');
  });

  it('a week out picks the weekly market', () => {
    const reply = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'week' }, ctx(BOARD));
    expect(reply.bet?.marketId).toBe('m-9d');
  });

  it('with no long market listed, answers with the nearest thing and says the real time left', () => {
    const short = BOARD.filter((c) => c.market.expiry - NOW < 2 * HOUR);
    const reply = respondToIntent({ kind: 'directional_bet', dir: 'up', conviction: 'even', horizon: 'week' }, ctx(short));
    expect(reply.bet?.marketId).toBe('m-1h');
  });
});

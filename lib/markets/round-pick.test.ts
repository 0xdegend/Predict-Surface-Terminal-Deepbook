import { describe, it, expect } from 'vitest';
import { bandCandidates, pickRound, pickAllRounds, HORIZON_MS } from './round-pick';
import { CADENCE_ORDER } from './v2-discovery';
import type { V2Market } from '@/lib/api/v2/types';

const NOW = 1_700_000_000_000;
const S = 1_000;

/** A live market expiring `leftS` seconds from now. `tenorMin` sets its SERIES, which
 *  the horizon rule must be free to ignore. */
function m(id: string, leftS: number, tenorMin = 3): V2Market {
  const expiry = NOW + leftS * S;
  return {
    expiry_market_id: id,
    expiry,
    checkpoint_timestamp_ms: expiry - tenorMin * 60 * S,
    tick_size: '10000000',
    admission_tick_size: '10000000',
    max_expiry_allocation: '0',
  } as V2Market;
}

describe('bandCandidates', () => {
  it('bands are disjoint, so no market can appear under two tabs', () => {
    const all = [m('a', 30), m('b', 90), m('c', 240), m('d', 600), m('e', 4000), m('f', 9600)];
    const seen = CADENCE_ORDER.flatMap((c) => bandCandidates(all, c, NOW).map((x) => x.expiry_market_id));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('excludes anything past the tab it belongs to', () => {
    // 2h40m out — the real hourly market, which the "1 hour" tab used to show while
    // labelling it an hour.
    const hourly = m('h', 9600, 180);
    expect(bandCandidates([hourly], '1h', NOW)).toHaveLength(0);
  });

  it('is exclusive at the lower bound and inclusive at the upper', () => {
    const exactlyOneMin = m('x', HORIZON_MS['1m'] / S);
    expect(bandCandidates([exactlyOneMin], '1m', NOW).map((v) => v.expiry_market_id)).toEqual(['x']);
    expect(bandCandidates([exactlyOneMin], '5m', NOW)).toHaveLength(0);
  });

  it('ignores which SERIES a market came from — only time left matters', () => {
    // The measured inversion: a 5-minute-series market with 58s left, and a
    // 1-minute-series market with 1:58 left.
    const fiveSeries = m('five', 58, 15);
    const oneSeries = m('one', 118, 3);
    expect(bandCandidates([fiveSeries, oneSeries], '1m', NOW).map((v) => v.expiry_market_id)).toEqual(['five']);
    expect(bandCandidates([fiveSeries, oneSeries], '5m', NOW).map((v) => v.expiry_market_id)).toEqual(['one']);
  });
});

describe('pickRound', () => {
  it('never returns a round that outlives its own tab', () => {
    const all = [m('a', 30), m('b', 118), m('c', 290), m('d', 890), m('e', 9600, 180)];
    for (const c of CADENCE_ORDER) {
      const got = pickRound(all, c, NOW);
      if (got) expect(got.expiry - NOW).toBeLessThanOrEqual(HORIZON_MS[c]);
    }
  });

  it('takes the LONGEST that fits, so a tab gives roughly the wait it advertises', () => {
    const all = [m('short', 40), m('long', 58)];
    expect(pickRound(all, '1m', NOW)!.expiry_market_id).toBe('long');
  });

  it('holds its pick so a countdown can never jump backwards', () => {
    const held = m('held', 40);
    // A further-out round crosses into the band and is now the longest.
    const crossed = m('crossed', 59);
    expect(pickRound([held, crossed], '1m', NOW, 'held')!.expiry_market_id).toBe('held');
    // Without the hold it would swap, which is the jump being prevented.
    expect(pickRound([held, crossed], '1m', NOW)!.expiry_market_id).toBe('crossed');
  });

  it('re-picks once the held round expires', () => {
    const gone = m('gone', -5);
    const next = m('next', 55);
    expect(pickRound([gone, next], '1m', NOW, 'gone')!.expiry_market_id).toBe('next');
  });

  it('re-picks once the held round leaves the band', () => {
    // A held 5m-band round that has ticked down under a minute belongs to the 1m tab now.
    const drifted = m('drifted', 40);
    const fits = m('fits', 200);
    expect(pickRound([drifted, fits], '5m', NOW, 'drifted')!.expiry_market_id).toBe('fits');
  });

  it('returns null rather than reaching outside the band', () => {
    // The exact bug: the 1m series skipped a rung, so the nearest round is 1:58 out.
    // Showing it under "1 min" is what we are replacing, so the tab says nothing instead.
    expect(pickRound([m('a', 118), m('b', 178)], '1m', NOW)).toBeNull();
  });
});

describe('pickAllRounds', () => {
  it('resolves the measured inversion into the right tabs', () => {
    // Live ladder captured at 21:19:02: the 1m series had skipped, so its soonest was
    // 1:58 while a 5m-series round sat at 0:58.
    const all = [m('5m-58s', 58, 15), m('1m-118s', 118, 3), m('1m-178s', 178, 3), m('5m-358s', 358, 15), m('5m-658s', 658, 15), m('1h', 9658, 180)];
    const picks = pickAllRounds(all, NOW, {});
    expect(picks['1m']!.expiry_market_id).toBe('5m-58s'); // closes in 0:58 ✓
    expect(picks['5m']!.expiry_market_id).toBe('1m-178s'); // longest under 5 min ✓
    expect(picks['1h']!.expiry_market_id).toBe('5m-658s'); // longest under an hour ✓
  });

  it('gives every tab a different round', () => {
    const all = [m('a', 30), m('b', 200), m('c', 900)];
    const picks = pickAllRounds(all, NOW, {});
    const ids = CADENCE_ORDER.map((c) => picks[c]?.expiry_market_id).filter(Boolean);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

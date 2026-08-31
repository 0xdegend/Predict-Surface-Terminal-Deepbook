/**
 * Classifying the 1-day and 1-week markets 8-21 added.
 *
 * A market on chain is keyed by (underlying, expiry) and has no cadence field. Verified
 * live on 8-21: the market expiring 2026-09-03T00:00Z answers BOTH the daily and the
 * weekly registry lookup with the same object id, exactly as the 18:25 market is both the
 * 1-minute and the 5-minute one. So an expiry belongs to every ladder whose period divides
 * it, and its cadence is the longest of those — which is also when it was first listed.
 *
 * These fixtures are therefore built the way the scheduler builds markets: expiries on a
 * cadence boundary from the epoch. Every live market checked has this property, and so do
 * all 500 rows the indexer retains.
 */
import { describe, it, expect } from 'vitest';
import { cadenceOf, CADENCE_LABEL, CADENCE_ORDER, groupByCadence, type V2Cadence } from './v2-discovery';
import { SIMPLE_CADENCES } from './round-pick';
import type { V2Market } from '@/lib/api/v2/types';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

/** A Thursday 00:00 UTC, i.e. an exact multiple of a week from the epoch — so it is
 *  simultaneously on the weekly, daily, hourly, 5-minute and 1-minute boundary, which is
 *  what makes it a usable base for every cadence below. */
const WEEK_BASE = 2904 * WEEK; // 2026-08-28T00:00:00Z

/** A market expiring `offsetMs` after the base. Creation time is passed separately and
 *  deliberately varied, because nothing should classify on it any more. */
function at(offsetMs: number, id = 'm', createdMs = WEEK_BASE - 3 * HOUR): V2Market {
  return {
    expiry_market_id: id,
    expiry: WEEK_BASE + offsetMs,
    checkpoint_timestamp_ms: createdMs,
  } as unknown as V2Market;
}

/** Whether THIS deployment schedules the long ladder at all. 8-06 has three cadences and
 *  8-21 has five, and cadenceOf answers against the ladder that exists, so the long-market
 *  expectations below only mean anything where those markets are listed. */
const LADDER = new Set(predictV2Config.cadences.map((c) => c.name));
const hasLong = LADDER.has('1d') && LADDER.has('1w');

describe.skipIf(!hasLong)('cadenceOf on the live 8-21 ladder', () => {
  it('classifies every cadence the venue lists', () => {
    expect(cadenceOf(at(61 * MIN))).toBe('1m'); // on the minute, not on a 5
    expect(cadenceOf(at(65 * MIN))).toBe('5m'); // on a 5, not on the hour
    expect(cadenceOf(at(5 * HOUR))).toBe('1h'); // on the hour, not midnight
    expect(cadenceOf(at(DAY))).toBe('1d'); // midnight, not a week boundary
    expect(cadenceOf(at(WEEK))).toBe('1w');
  });

  it('does not call a week-long market hourly', () => {
    // The original bug: every long market read as '1h', so a bet settling nine days out
    // was labelled "Hourly" on the cards, the ticket chip, the share card and analytics.
    expect(cadenceOf(at(WEEK))).not.toBe('1h');
    expect(cadenceOf(at(DAY))).not.toBe('1h');
  });

  it('classifies the same market the same way whenever it was created', () => {
    // The property that replaced the tenor heuristic, and the reason discovery can now
    // find markets it holds no creation event for. windowSize is protocol config (3 on the
    // older deployments, 2 on 8-21), and one observed 1w market was listed 290h ahead
    // rather than 336h — under the old rule those shifted the answer, and a market found
    // by registry lookup had no creation time to measure at all.
    for (const created of [WEEK_BASE - 14 * DAY, WEEK_BASE - 3 * HOUR, WEEK_BASE + 6 * HOUR, 0]) {
      expect(cadenceOf(at(WEEK, 'w', created))).toBe('1w');
      expect(cadenceOf(at(5 * HOUR, 'h', created))).toBe('1h');
      expect(cadenceOf(at(61 * MIN, 'm', created))).toBe('1m');
    }
  });

  it('gives every cadence a label and a place in the order', () => {
    // A missing entry renders as `undefined` in a chip rather than throwing.
    for (const c of CADENCE_ORDER) expect(CADENCE_LABEL[c], `no label for ${c}`).toBeTruthy();
    expect(CADENCE_ORDER).toContain('1d');
    expect(CADENCE_ORDER).toContain('1w');
  });

  it('groups long markets into their own buckets rather than the hourly one', () => {
    const grouped = groupByCadence([at(5 * HOUR, 'h'), at(DAY, 'd'), at(WEEK, 'w')]);
    expect(grouped['1h'].map((m) => m.expiry_market_id)).toEqual(['h']);
    expect(grouped['1d'].map((m) => m.expiry_market_id)).toEqual(['d']);
    expect(grouped['1w'].map((m) => m.expiry_market_id)).toEqual(['w']);
  });
});

describe('simple mode stays on the short rounds', () => {
  it('offers only the three cadences that suit a watchable round', () => {
    // Deliberate, not incidental: simple mode is the beginner screen, built around a
    // countdown you watch resolve and a live pinned line. A week-long round has neither.
    // Typed as a subset so adding a venue cadence cannot silently add a tab here.
    expect([...SIMPLE_CADENCES]).toEqual(['1m', '5m', '1h']);
    const simple = new Set<V2Cadence>(SIMPLE_CADENCES);
    expect(simple.has('1d' as V2Cadence)).toBe(false);
    expect(simple.has('1w' as V2Cadence)).toBe(false);
  });

  it('still lists the long cadences on the terminal', () => {
    // The capability is shipped; it is only simple mode that opts out.
    expect(CADENCE_ORDER.length).toBeGreaterThan(SIMPLE_CADENCES.length);
  });
});

describe.skipIf(hasLong)(`cadenceOf where there is no long ladder (${ACTIVE_V2_DEPLOYMENT})`, () => {
  it('calls a midnight expiry the hourly market', () => {
    // Not a fallback or a rounding error: on a deployment with no daily cadence, the
    // market expiring at midnight IS the hourly one, because hourly is the longest ladder
    // whose period divides that expiry. The same expiry answers to a different name on
    // 8-21 only because a longer ladder exists there to claim it.
    expect(cadenceOf(at(DAY))).toBe('1h');
    expect(cadenceOf(at(WEEK))).toBe('1h');
    expect(cadenceOf(at(61 * MIN))).toBe('1m');
    expect(cadenceOf(at(65 * MIN))).toBe('5m');
  });

  it('offers no long cadence to group into', () => {
    expect(LADDER.has('1d')).toBe(false);
    expect(LADDER.has('1w')).toBe(false);
  });
});

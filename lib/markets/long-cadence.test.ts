/**
 * Classifying the 1-day and 1-week markets 8-21 added.
 *
 * `cadenceOf` used to end with "tenor over 40 minutes means hourly", which was true by
 * construction while every listed market settled within the hour. On 8-21 it is not. A
 * 1-week market satisfies that test, so before this change a bet settling nine days out was
 * labelled "Hourly" everywhere it appeared: the market cards, the trade ticket's chip, the
 * share card, the analytics grouping.
 *
 * The tenors below are measured from the live 8-21 board on 2026-08-31 via
 * predict-server-v4, not invented:
 *
 *   1m 0.03h   5m 0.17h   1h 2.00h   1d 48.00h   1w 336.00h   (and one 1w at 290.39h)
 */
import { describe, it, expect } from 'vitest';
import { cadenceOf, CADENCE_LABEL, CADENCE_ORDER, groupByCadence, type V2Cadence } from './v2-discovery';
import { SIMPLE_CADENCES } from './round-pick';
import type { V2Market } from '@/lib/api/v2/types';

const CREATED = 1_756_600_000_000;
const HOUR = 3_600_000;

/** A market with a given creation tenor and allocation, as the event carries them. */
function market(lifeHours: number, alloc: string, id = 'm'): V2Market {
  return {
    expiry_market_id: id,
    expiry: CREATED + lifeHours * HOUR,
    checkpoint_timestamp_ms: CREATED,
    max_expiry_allocation: alloc,
  } as unknown as V2Market;
}

const SHORT_ALLOC = '50000000000';
const LONG_ALLOC = '250000000000'; // shared by 1h, 1d AND 1w on 8-21

describe('cadenceOf on the live 8-21 tenors', () => {
  it('classifies every cadence the venue lists', () => {
    expect(cadenceOf(market(0.03, SHORT_ALLOC))).toBe('1m');
    expect(cadenceOf(market(0.17, SHORT_ALLOC))).toBe('5m');
    expect(cadenceOf(market(2.0, LONG_ALLOC))).toBe('1h');
    expect(cadenceOf(market(48.0, LONG_ALLOC))).toBe('1d');
    expect(cadenceOf(market(336.0, LONG_ALLOC))).toBe('1w');
  });

  it('does not call a week-long market hourly', () => {
    // The bug. Both of these passed the old `tenorMs > 40min` test and came out '1h'.
    expect(cadenceOf(market(336.0, LONG_ALLOC))).not.toBe('1h');
    expect(cadenceOf(market(48.0, LONG_ALLOC))).not.toBe('1h');
  });

  it('handles the odd 1w market that came in short of a full two weeks', () => {
    // One observed 1w market had a 290h life rather than 336h, which is why the daily bound
    // sits at a week rather than just above two days.
    expect(cadenceOf(market(290.39, LONG_ALLOC))).toBe('1w');
  });

  it('survives a windowSize change without reclassifying the hourly cadence', () => {
    // windowSize is protocol config: it was 3 on the older deployments and is 2 on 8-21. An
    // hourly market at windowSize 3 is a 3h tenor and must still read as hourly, not daily.
    expect(cadenceOf(market(3, LONG_ALLOC))).toBe('1h');
    expect(cadenceOf(market(0.05, SHORT_ALLOC))).toBe('1m'); // 3-minute 1m tenor
    expect(cadenceOf(market(0.25, SHORT_ALLOC))).toBe('5m'); // 15-minute 5m tenor
  });

  it('gives every cadence a label and a place in the order', () => {
    // A missing entry renders as `undefined` in a chip rather than throwing.
    for (const c of CADENCE_ORDER) expect(CADENCE_LABEL[c], `no label for ${c}`).toBeTruthy();
    expect(CADENCE_ORDER).toContain('1d');
    expect(CADENCE_ORDER).toContain('1w');
  });

  it('groups long markets into their own buckets rather than the hourly one', () => {
    const grouped = groupByCadence([
      market(2.0, LONG_ALLOC, 'h'),
      market(48.0, LONG_ALLOC, 'd'),
      market(336.0, LONG_ALLOC, 'w'),
    ]);
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

import { describe, it, expect } from 'vitest';
import {
  tenorBand,
  tenorBandFromMsLeft,
  atLeast,
  outsideContext,
  vegaMeaningful,
  realizedWindowMins,
  pickAcrossTenors,
  TENOR_ORDER,
} from './tenor';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

describe('tenorBandFromMsLeft', () => {
  it('buckets each live cadence into its own band', () => {
    expect(tenorBandFromMsLeft(45 * 1000)).toBe('flash'); // a 1m market mid-life
    expect(tenorBandFromMsLeft(4 * MIN)).toBe('short'); // a 5m market
    expect(tenorBandFromMsLeft(50 * MIN)).toBe('hour'); // a 1h market
  });

  it('buckets the tenors that do not exist yet', () => {
    expect(tenorBandFromMsLeft(20 * HOUR)).toBe('day');
    expect(tenorBandFromMsLeft(6 * DAY)).toBe('week');
    expect(tenorBandFromMsLeft(30 * DAY)).toBe('week');
  });

  it('reads TIME LEFT, not the product: an hourly market in its last seconds is flash', () => {
    expect(tenorBandFromMsLeft(20 * 1000)).toBe('flash');
  });

  it('treats an expired or non-finite market as the shortest band rather than throwing', () => {
    expect(tenorBandFromMsLeft(0)).toBe('flash');
    expect(tenorBandFromMsLeft(-5 * MIN)).toBe('flash');
    expect(tenorBandFromMsLeft(Number.NaN)).toBe('flash');
  });

  it('is exclusive at each upper bound, so a boundary lands in the longer band', () => {
    expect(tenorBandFromMsLeft(3 * MIN - 1)).toBe('flash');
    expect(tenorBandFromMsLeft(3 * MIN)).toBe('short');
    expect(tenorBandFromMsLeft(30 * MIN)).toBe('hour');
    expect(tenorBandFromMsLeft(6 * HOUR)).toBe('day');
    expect(tenorBandFromMsLeft(3 * DAY)).toBe('week');
  });
});

describe('tenorBand', () => {
  it('measures against the injected clock, never a real one', () => {
    expect(tenorBand(NOW + 45 * 1000, NOW)).toBe('flash');
    expect(tenorBand(NOW + 50 * MIN, NOW)).toBe('hour');
  });
});

describe('atLeast', () => {
  it('orders the bands shortest to longest', () => {
    expect(TENOR_ORDER).toEqual(['flash', 'short', 'hour', 'day', 'week']);
    expect(atLeast('week', 'hour')).toBe(true);
    expect(atLeast('hour', 'hour')).toBe(true);
    expect(atLeast('short', 'hour')).toBe(false);
  });
});

describe('outsideContext', () => {
  it('treats a monthly Deribit pin as unrelated to a minute-scale bet', () => {
    expect(outsideContext('flash')).toBe('unrelated');
    expect(outsideContext('short')).toBe('unrelated');
  });

  it('demotes it to backdrop on the hour, and promotes it once horizons match', () => {
    expect(outsideContext('hour')).toBe('backdrop');
    expect(outsideContext('day')).toBe('primary');
    expect(outsideContext('week')).toBe('primary');
  });
});

describe('vegaMeaningful', () => {
  it('is false on the minute scale, where a binary has effectively none', () => {
    expect(vegaMeaningful('flash')).toBe(false);
    expect(vegaMeaningful('short')).toBe(false);
  });

  it('is true from an hour out', () => {
    expect(vegaMeaningful('hour')).toBe(true);
    expect(vegaMeaningful('week')).toBe(true);
  });
});

describe('realizedWindowMins', () => {
  it('matches the lookback to the horizon being priced', () => {
    expect(realizedWindowMins('flash')).toBe(5);
    expect(realizedWindowMins('hour')).toBe(60);
    expect(realizedWindowMins('week')).toBe(7 * 24 * 60);
  });

  it('is strictly increasing across the bands', () => {
    const mins = TENOR_ORDER.map(realizedWindowMins);
    for (let i = 1; i < mins.length; i++) expect(mins[i]).toBeGreaterThan(mins[i - 1]);
  });
});

describe('pickAcrossTenors', () => {
  const at = (msLeft: number, id: string) => ({ id, expiry: NOW + msLeft });

  it('spreads the picks across horizons instead of clustering on the soonest', () => {
    const markets = [
      at(30 * 1000, 'a'),
      at(60 * 1000, 'b'),
      at(90 * 1000, 'c'), // three flash markets
      at(4 * MIN, 'd'),
      at(9 * MIN, 'e'), // two short
      at(50 * MIN, 'f'), // one hour
    ];
    expect(pickAcrossTenors(markets, (m) => m.expiry, NOW, 2).map((m) => m.id)).toEqual([
      'a',
      'b',
      'd',
      'e',
      'f',
    ]);
  });

  it('picks up 1d and 1w markets with no change to the caller', () => {
    const markets = [at(30 * 1000, 'flash'), at(20 * HOUR, 'day'), at(6 * DAY, 'week')];
    expect(pickAcrossTenors(markets, (m) => m.expiry, NOW, 1).map((m) => m.id)).toEqual([
      'flash',
      'day',
      'week',
    ]);
  });

  it('returns bands in TENOR_ORDER regardless of input order', () => {
    const markets = [at(6 * DAY, 'week'), at(30 * 1000, 'flash'), at(50 * MIN, 'hour')];
    expect(pickAcrossTenors(markets, (m) => m.expiry, NOW, 1).map((m) => m.id)).toEqual([
      'flash',
      'hour',
      'week',
    ]);
  });

  it('preserves input order within a band', () => {
    const markets = [at(90 * 1000, 'c'), at(30 * 1000, 'a'), at(60 * 1000, 'b')];
    expect(pickAcrossTenors(markets, (m) => m.expiry, NOW, 3).map((m) => m.id)).toEqual(['c', 'a', 'b']);
  });

  it('is empty for no markets', () => {
    expect(pickAcrossTenors([], (m: { expiry: number }) => m.expiry, NOW)).toEqual([]);
  });
});

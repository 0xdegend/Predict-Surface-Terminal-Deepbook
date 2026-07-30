import { describe, it, expect } from 'vitest';
import {
  topEvent,
  notableEvents,
  relTime,
  eventName,
  eventGreetingLine,
  buildEventsReply,
  prettyTitle,
  type EventsFeed,
  type MarketEvent,
} from './events';

const NOW = 1_785_000_000_000;
const HOUR = 3_600_000;

function ev(p: Partial<MarketEvent> = {}): MarketEvent {
  return {
    title: 'Some Data',
    country: 'US',
    importance: 2,
    at: null,
    released: false,
    forecast: null,
    previous: null,
    actual: null,
    effect: null,
    ...p,
  };
}

function feed(events: MarketEvent[], headline: string | null = null): EventsFeed {
  return { available: true, asOf: NOW, events, headline };
}

describe('notableEvents / topEvent', () => {
  it('surfaces only high-impact (importance 3) and keeps the route order', () => {
    const f = feed([ev({ title: 'FOMC', importance: 3 }), ev({ title: 'PCE', importance: 3 }), ev({ title: 'Retail', importance: 2 })]);
    expect(notableEvents(f).map((e) => e.title)).toEqual(['FOMC', 'PCE']);
    expect(topEvent(f)?.title).toBe('FOMC');
  });

  it('returns nothing for an unavailable / empty / routine-only feed', () => {
    expect(topEvent(null)).toBeNull();
    expect(topEvent({ available: false, asOf: NOW, events: [], headline: null })).toBeNull();
    expect(topEvent(feed([ev({ importance: 2 }), ev({ importance: 1 })]))).toBeNull();
  });
});

describe('relTime (coarse + timezone-safe)', () => {
  it('phrases upcoming events by distance', () => {
    expect(relTime(ev({ at: NOW + 3 * HOUR }), NOW)).toBe('in about 3 hours');
    expect(relTime(ev({ at: NOW + 45 * 60_000 }), NOW)).toBe('within the hour');
    expect(relTime(ev({ at: NOW + 26 * HOUR }), NOW)).toBe('tomorrow');
    expect(relTime(ev({ at: null }), NOW)).toBe('later today');
  });

  it('phrases released events', () => {
    expect(relTime(ev({ released: true, at: NOW - 30 * 60_000 }), NOW)).toBe('in the last couple of hours');
    expect(relTime(ev({ released: true, at: NOW - 5 * HOUR }), NOW)).toBe('earlier today');
    expect(relTime(ev({ released: true, at: null }), NOW)).toBe('earlier today');
    // A time already in the past reads as released even without the flag.
    expect(relTime(ev({ released: false, at: NOW - 5 * HOUR }), NOW)).toBe('earlier today');
  });
});

describe('prettyTitle', () => {
  it('maps the common noisy releases to plain, country-free names', () => {
    expect(prettyTitle('Federal Funds Benchmark Rate')).toBe('interest rate decision');
    expect(prettyTitle('Overnight Target interest rate')).toBe('interest rate decision');
    expect(prettyTitle('official bank rate')).toBe('interest rate decision');
    expect(prettyTitle('Personal consumption expenditure price index (MoM)(Jun)')).toBe('PCE inflation');
    expect(prettyTitle('Personal consumption expenditure (MoM)(Jun)')).toBe('consumer spending');
    expect(prettyTitle('Real GDP(AQR)(Preliminary)(Q2)')).toBe('GDP');
    expect(prettyTitle("Number of seasonally adjusted initial K'in claims last week (thousands)(to 0725)")).toBe('jobless claims');
    expect(prettyTitle('Consumer Price Index (YoY)')).toBe('CPI inflation');
  });

  it('falls back to a parentheses-stripped title for anything unmapped', () => {
    expect(prettyTitle('Widget Sentiment Survey (Flash)(Aug)')).toBe('Widget Sentiment Survey');
  });
});

describe('eventName', () => {
  it('prefixes the country only when the title does not already carry it', () => {
    expect(eventName(ev({ title: 'Jobless Claims', country: 'US' }))).toBe('US Jobless Claims');
    expect(eventName(ev({ title: 'US Nonfarm Payrolls', country: 'US' }))).toBe('US Nonfarm Payrolls');
    // "US" must match as a word, not inside "trust".
    expect(eventName(ev({ title: 'Consumer Trust', country: 'US' }))).toBe('US Consumer Trust');
    expect(eventName(ev({ title: 'Fed Rate Decision', country: null }))).toBe('Fed Rate Decision');
  });
});

describe('eventGreetingLine', () => {
  it('names the biggest event and points at the full read', () => {
    const line = eventGreetingLine(feed([ev({ title: 'Fed Interest Rate Decision', importance: 3 })]));
    expect(line).toMatch(/big market event/i);
    expect(line).toMatch(/is on the calendar/i); // upcoming (released: false)
    expect(line).toMatch(/Fed Interest Rate Decision/);
    expect(line).toMatch(/what.s happening today/i);
  });

  it('says a released event already came out', () => {
    const line = eventGreetingLine(feed([ev({ title: 'CPI', importance: 3, released: true })]));
    expect(line).toMatch(/already came out today/i);
  });

  it('is null when nothing high-impact is on (routine days included)', () => {
    expect(eventGreetingLine(null)).toBeNull();
    expect(eventGreetingLine(feed([ev({ importance: 2 })]))).toBeNull();
  });

  it('never uses an em dash', () => {
    const line = eventGreetingLine(feed([ev({ title: 'CPI', importance: 3 })]));
    expect(line).not.toMatch(/—/);
  });
});

describe('buildEventsReply', () => {
  it('explains when it cannot pull the calendar', () => {
    expect(buildEventsReply(null, NOW)[0]).toMatch(/can.t pull today.s calendar/i);
  });

  it('says the calendar is quiet when nothing is high-impact (routine only)', () => {
    const out = buildEventsReply(feed([ev({ importance: 2 })]), NOW);
    expect(out[0]).toMatch(/nothing major/i);
    expect(out.join(' ')).not.toMatch(/big one/i);
  });

  it('leads with the top event, lists the rest, and always adds the caveat', () => {
    const out = buildEventsReply(
      feed(
        [
          ev({ title: 'Fed Interest Rate Decision', importance: 3, at: NOW + 3 * HOUR }),
          ev({ title: 'Jobless Claims', importance: 3, released: true, at: NOW - 5 * HOUR }),
        ],
        'Bitcoin steadies ahead of the Fed',
      ),
      NOW,
    );
    const joined = out.join('\n');
    expect(joined).toMatch(/big one/i);
    expect(joined).toMatch(/Fed Interest Rate Decision \(in about 3 hours\)/);
    expect(joined).toMatch(/Also today:.*Jobless Claims \(earlier today\)/);
    expect(joined).toMatch(/Bitcoin steadies ahead of the Fed/);
    expect(joined).toMatch(/not a prediction/i);
    expect(joined).not.toMatch(/—/); // no em dash
  });
});

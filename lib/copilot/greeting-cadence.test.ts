import { describe, it, expect } from 'vitest';
import { localDay, decideVisit } from './greeting-cadence';

describe('localDay', () => {
  it('is day-granular (drops the clock)', () => {
    const morning = new Date('2026-08-17T09:00:00');
    const evening = new Date('2026-08-17T21:30:00');
    expect(localDay(morning)).toBe(localDay(evening));
  });

  it('changes across calendar days', () => {
    expect(localDay(new Date('2026-08-17T23:00:00'))).not.toBe(
      localDay(new Date('2026-08-18T01:00:00')),
    );
  });
});

describe('decideVisit', () => {
  it('treats a never-seen wallet as a first visit', () => {
    expect(decideVisit(null, 'Mon Aug 17 2026').firstToday).toBe(true);
  });

  it('treats a stamp from an earlier day as a first visit', () => {
    expect(decideVisit('Sun Aug 16 2026', 'Mon Aug 17 2026').firstToday).toBe(true);
  });

  it('treats a stamp from today as a repeat visit', () => {
    expect(decideVisit('Mon Aug 17 2026', 'Mon Aug 17 2026').firstToday).toBe(false);
  });

  it('always hands back today as the stamp to persist', () => {
    expect(decideVisit(null, 'Mon Aug 17 2026').nextStamp).toBe('Mon Aug 17 2026');
    expect(decideVisit('Sun Aug 16 2026', 'Mon Aug 17 2026').nextStamp).toBe('Mon Aug 17 2026');
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import {
  deriveLearnedProfile,
  learnedLessonNotes,
  learnedOpener,
  claimLessonSlot,
  _resetLessonClaims,
} from './lessons';
import type { PastPrediction } from '@/lib/portfolio/history';

/** Minimal settled row; override only what a case cares about. */
function row(p: Partial<PastPrediction>, i = 0): PastPrediction {
  return {
    key: `k${i}-${Math.random().toString(36).slice(2)}`,
    oracleId: 'o',
    underlying: 'BTC',
    up: true,
    strike: 60_000,
    expiry: 0,
    settledAt: 0,
    result: 'won',
    contracts: 1,
    cost: 10,
    payout: 20,
    pnl: 10,
    roi: 1,
    entryPrice: 0.5,
    ...p,
  };
}
const many = (n: number, p: Partial<PastPrediction>) => Array.from({ length: n }, (_, i) => row(p, i));

describe('deriveLearnedProfile', () => {
  it('learns nothing until there is enough settled history', () => {
    const profile = deriveLearnedProfile(many(5, { entryPrice: 0.7, result: 'won' }));
    expect(profile).toEqual({ sample: 5 });
  });

  it('detects a SAFE edge when favorites beat fair and longshots do not', () => {
    const history = [
      ...many(4, { up: true, entryPrice: 0.7, result: 'won' }), // safe bucket: edge +0.30
      ...many(4, { up: true, entryPrice: 0.25, result: 'lost' }), // bold bucket: edge -0.25
    ];
    const p = deriveLearnedProfile(history);
    expect(p.risk).toBe('safe');
    expect(p.lean).toBeUndefined(); // all one direction → no direction signal
    expect(p.sample).toBe(8);
  });

  it('detects a directional lean when one side out-edges the other', () => {
    const history = [
      ...many(4, { up: true, entryPrice: 0.5, result: 'won' }), // up edge +0.5
      ...many(4, { up: false, entryPrice: 0.5, result: 'lost' }), // down edge -0.5
    ];
    const p = deriveLearnedProfile(history);
    expect(p.lean).toBe('up');
    expect(p.risk).toBeUndefined(); // mid entryPrice → excluded from risk buckets
  });

  it('flags a range strength when range beats binary by a clear margin', () => {
    const history = [
      ...many(4, { band: { lower: 59_000, higher: 61_000 }, entryPrice: 0.5, result: 'won' }),
      ...many(4, { up: true, entryPrice: 0.5, result: 'lost' }),
    ];
    expect(deriveLearnedProfile(history).likesRange).toBe(true);
  });

  it('stays silent when the edge gap is within the noise threshold', () => {
    const history = [
      ...many(3, { up: true, entryPrice: 0.5, result: 'won' }),
      ...many(3, { up: true, entryPrice: 0.5, result: 'lost' }),
      ...many(3, { up: false, entryPrice: 0.5, result: 'won' }),
      ...many(3, { up: false, entryPrice: 0.5, result: 'lost' }),
    ];
    const p = deriveLearnedProfile(history);
    expect(p.lean).toBeUndefined();
    expect(p.risk).toBeUndefined();
    expect(p.likesRange).toBeUndefined();
  });
});

describe('learnedLessonNotes', () => {
  it('turns a profile into stable, number-free notes, capped at two', () => {
    const notes = learnedLessonNotes({ sample: 20, risk: 'safe', lean: 'up', likesRange: true });
    expect(notes).toHaveLength(2);
    expect(notes[0]).toContain('safer bets');
    expect(notes[1]).toContain('UP');
    expect(notes.join(' ')).not.toMatch(/\d/); // no volatile counts
  });

  it('is empty for a profile with nothing learned', () => {
    expect(learnedLessonNotes({ sample: 3 })).toEqual([]);
  });
});

describe('learnedOpener', () => {
  it('reads as an honest, results-based opener', () => {
    expect(learnedOpener({ sample: 20, lean: 'up', risk: 'safe' })).toBe(
      "Going by your own settled bets, you tend to do better on UP bets and safer bets have worked out for you, so here's one in that lane.",
    );
  });

  it('is null when nothing directional or risk-related was learned', () => {
    expect(learnedOpener({ sample: 20, likesRange: true })).toBeNull();
    expect(learnedOpener({ sample: 3 })).toBeNull();
  });
});

describe('claimLessonSlot', () => {
  beforeEach(() => _resetLessonClaims());
  it('is true once per wallet per session, then false', () => {
    expect(claimLessonSlot('0xABC')).toBe(true);
    expect(claimLessonSlot('0xabc')).toBe(false); // case-insensitive
    expect(claimLessonSlot('0xDEF')).toBe(true);
  });
});

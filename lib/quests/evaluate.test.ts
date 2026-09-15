import { describe, it, expect } from 'vitest';
import { evaluateQuest, evaluateAll, earnedPoints, measurableCount, type MetricSource } from './evaluate';
import { QUESTS, questById, TOTAL_QUEST_POINTS, type QuestDef } from '@/config/quests';

const def = (over: Partial<QuestDef> = {}): QuestDef => ({
  id: 't',
  category: 'volume',
  icon: 'trending',
  title: 'T',
  desc: 'd',
  points: 100,
  metric: 'volume',
  target: 50,
  window: 'week',
  unit: 'dusdc',
  ...over,
});

const week = (metrics: MetricSource['metrics']): MetricSource[] => [{ window: 'week', metrics }];

describe('the undefined / zero distinction', () => {
  it('reports a metric nobody measured as unavailable, not as 0%', () => {
    // Showing a metric we never read as a stuck 0% would imply we looked and found
    // nothing. Deposits is the live case: it stays absent until the account read lands.
    const r = evaluateQuest(def({ metric: 'deposits', window: 'week' }), week({ volume: 10 }));
    expect(r.state).toBe('unavailable');
    expect(r.label).toBe('Coming soon');
    expect(r.progress).toBe(0);
  });

  it('reports a metric we measured as empty as an active quest at zero', () => {
    const r = evaluateQuest(def(), week({ volume: 0 }));
    expect(r.state).toBe('active');
    expect(r.progress).toBe(0);
    expect(r.label).toBe('0 / 50 DUSDC');
  });

  it('treats a non-finite reading as unmeasured rather than as a number', () => {
    expect(evaluateQuest(def(), week({ volume: NaN })).state).toBe('unavailable');
    expect(evaluateQuest(def(), week({ volume: Infinity })).state).toBe('unavailable');
  });
});

describe('a window is a claim about coverage', () => {
  it('refuses to score a lifetime quest from a windowed source', () => {
    // Scoring a lifetime target off a weekly total resets every Monday, and lets the
    // same quest complete again and again.
    const r = evaluateQuest(def({ window: 'lifetime' }), week({ volume: 999 }));
    expect(r.state).toBe('unavailable');
  });

  it('scores it once a source actually covering that span is supplied', () => {
    const sources: MetricSource[] = [
      { window: 'week', metrics: { volume: 10 } },
      { window: 'lifetime', metrics: { volume: 999 } },
    ];
    expect(evaluateQuest(def({ window: 'lifetime' }), sources).state).toBe('complete');
    // and the weekly quest still reads its own window, not the bigger number
    expect(evaluateQuest(def(), sources).current).toBe(10);
  });
});

describe('progress arithmetic', () => {
  it('clamps at the target and calls it complete', () => {
    const r = evaluateQuest(def(), week({ volume: 80 }));
    expect(r.progress).toBe(1);
    expect(r.state).toBe('complete');
    expect(r.label).toBe('Complete');
  });

  it('never reads a signed metric as negative progress', () => {
    const r = evaluateQuest(def({ metric: 'netPnl', unit: 'dusdc' }), week({ netPnl: -40 }));
    expect(r.progress).toBe(0);
    expect(r.current).toBe(0);
    expect(r.state).toBe('active');
  });

  it('refuses a zero target instead of completing on a divide by zero', () => {
    expect(evaluateQuest(def({ target: 0 }), week({ volume: 5 })).state).toBe('unavailable');
  });

  it('trims fold floats so a label reads 32 rather than 32.0000001', () => {
    expect(evaluateQuest(def(), week({ volume: 32.000000001 })).label).toBe('32 / 50 DUSDC');
  });

  it('writes counted quests with their noun and money quests with the symbol', () => {
    expect(evaluateQuest(def({ metric: 'wins', target: 3, unit: 'count', noun: 'wins' }), week({ wins: 1 })).label).toBe('1 / 3 wins');
    expect(evaluateQuest(def({ metric: 'trades', target: 1, unit: 'count' }), week({ trades: 0 })).label).toBe('0 / 1');
    expect(evaluateQuest(def(), week({ volume: 5 }), 'USDC').label).toBe('5 / 50 USDC');
  });
});

describe('the real catalog, against what the fold actually measures', () => {
  /** What lib/quests/from-activity reports for a wallet that has done nothing at all:
   *  every key measured, every key zero. Written out rather than imported so this file
   *  keeps testing the evaluator alone. */
  const zeros = {
    trades: 0, volume: 0, wins: 0, netPnl: 0,
    settledCloses: 0, distinctMarkets: 0, rangeTrades: 0,
  };
  const empty: MetricSource[] = [
    { window: 'lifetime', metrics: { ...zeros, deposits: 0 } },
    { window: 'week', metrics: { ...zeros } },
  ];

  it('scores every shipped quest, none left as coming soon', () => {
    const rows = evaluateAll(empty);
    expect(rows.filter((r) => r.state === 'unavailable')).toEqual([]);
    expect(measurableCount(rows)).toBe(QUESTS.length);
  });

  it('a wallet that has never traded sits at zero rather than going blank', () => {
    const rows = evaluateAll(empty);
    expect(rows.find((r) => r.id === 'first-trade')).toMatchObject({ state: 'active', current: 0, label: '0 / 1' });
    expect(earnedPoints(rows)).toBe(0);
  });

  it('only the deposits quest waits when the account read has not landed', () => {
    // from-activity omits `deposits` entirely until it can prove one way or the other,
    // and a lower bound it cannot yet state must not render as a stuck 0%.
    const pending: MetricSource[] = [
      { window: 'lifetime', metrics: { ...zeros } },
      { window: 'week', metrics: { ...zeros } },
    ];
    const rows = evaluateAll(pending);
    expect(rows.filter((r) => r.state === 'unavailable').map((r) => r.id)).toEqual(['fund-manager']);
  });

  it('a real record completes the quests it has earned and only those', () => {
    const measured = {
      trades: 7, volume: 120, wins: 4, netPnl: 3,
      settledCloses: 0, distinctMarkets: 2, rangeTrades: 0, deposits: 1,
    };
    const rows = evaluateAll([
      { window: 'lifetime', metrics: measured },
      { window: 'week', metrics: { ...measured, volume: 40 } },
    ]);
    const by = (id: string) => rows.find((r) => r.id === id)!;
    expect(by('first-trade').state).toBe('complete'); // 7 trades >= 1
    expect(by('fund-manager').state).toBe('complete'); // a trade proves a deposit
    expect(by('sharp-shooter').state).toBe('complete'); // 4 wins >= 3
    expect(by('market-maker').state).toBe('active'); // 120 of 250 lifetime
    expect(by('market-maker').label).toBe('120 / 250 DUSDC');
    // the weekly quest reads the WEEK, so a big lifetime total does not complete it
    expect(by('volume-climber')).toMatchObject({ state: 'active', label: '40 / 50 DUSDC' });
    expect(by('diamond-hands').state).toBe('active'); // never held one to settlement
    expect(by('explorer').label).toBe('2 / 3 markets');
    expect(earnedPoints(rows)).toBe(
      questById('first-trade')!.points + questById('fund-manager')!.points + questById('sharp-shooter')!.points,
    );
  });

  it('every quest in the catalog has a positive target and a positive reward', () => {
    for (const q of QUESTS) {
      expect(q.target, q.id).toBeGreaterThan(0);
      expect(q.points, q.id).toBeGreaterThan(0);
    }
    expect(TOTAL_QUEST_POINTS).toBe(QUESTS.reduce((n, q) => n + q.points, 0));
  });

  it('quest ids are unique, because the ledger will key payouts on them', () => {
    expect(new Set(QUESTS.map((q) => q.id)).size).toBe(QUESTS.length);
  });
});

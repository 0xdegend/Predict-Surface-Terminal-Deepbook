import { describe, it, expect } from 'vitest';
import type { RunResult, RunTradeResult } from '@/lib/store/autopilot-store';
import {
  buildSessionShare,
  durationWords,
  fmtUsd,
  sessionShareKinds,
  sessionShareText,
  tradeWords,
} from './autopilot-share';

const NO_EMDASH = /—/;

function trade(over: Partial<RunTradeResult> & { pnlUsd: number; at: number }): RunTradeResult {
  return {
    marketId: `m-${over.at}`,
    side: 'up',
    strike: 79_600,
    stake: 5,
    entryProb: 0.68,
    outcome: over.pnlUsd > 0 ? 'won' : over.pnlUsd < 0 ? 'lost' : 'pending',
    digest: null,
    ...over,
  };
}

function run(over: Partial<RunResult> = {}): RunResult {
  const trades = over.trades ?? [
    trade({ at: 10, pnlUsd: 3.1 }),
    trade({ at: 20, pnlUsd: -5, side: 'down' }),
    trade({ at: 30, pnlUsd: 2.2, strike: 80_100 }),
  ];
  const wins = trades.filter((t) => t.outcome === 'won').length;
  const losses = trades.filter((t) => t.outcome === 'lost').length;
  return {
    id: 'r1',
    armedAt: 1_000_000,
    endedAt: 1_000_000 + 42 * 60_000,
    dryRun: false,
    stopReason: 'budget_spent',
    budgetUsd: 25,
    perTradeUsd: 5,
    tradeCount: trades.length,
    wins,
    losses,
    pendingCount: trades.filter((t) => t.outcome === 'pending').length,
    realizedPnlUsd: trades.reduce((a, t) => a + t.pnlUsd, 0),
    trades,
    preset: 'balanced',
    ...over,
  };
}

describe('formatting', () => {
  it('signs dollars with cents', () => {
    expect(fmtUsd(4.2)).toBe('+$4.20');
    expect(fmtUsd(-1.5)).toBe('-$1.50');
    expect(fmtUsd(0)).toBe('+$0.00');
  });

  it('says a duration in plain words', () => {
    expect(durationWords(20_000)).toBe('under a minute');
    expect(durationWords(60_000)).toBe('1 minute');
    expect(durationWords(42 * 60_000)).toBe('42 minutes');
    expect(durationWords(72 * 60_000)).toBe('1h 12m');
    expect(durationWords(120 * 60_000)).toBe('2 hours');
  });

  it('describes a trade the way the ticket does', () => {
    expect(tradeWords({ side: 'up', strike: 79_600, stake: 5, entryProb: 0.6, pnlUsd: 1 })).toBe('UP above $79,600');
    expect(tradeWords({ side: 'down', strike: 79_600, stake: 5, entryProb: 0.6, pnlUsd: 1 })).toBe('DOWN below $79,600');
    expect(tradeWords({ side: 'range', lower: 79_000, higher: 80_000, stake: 5, entryProb: 0.6, pnlUsd: 1 })).toBe(
      '$79,000 to $80,000 range',
    );
  });
});

describe('buildSessionShare', () => {
  it('reads the run into the numbers the cards paint', () => {
    const d = buildSessionShare(run());
    expect(d.netUsd).toBeCloseTo(0.3);
    expect(d.wins).toBe(2);
    expect(d.losses).toBe(1);
    expect(d.winRate).toBeCloseTo(2 / 3);
    expect(d.durationMs).toBe(42 * 60_000);
    expect(d.stakedUsd).toBe(15);
    expect(d.settledCount).toBe(3);
    expect(d.curve).toEqual([3.1, -1.9, 0.3].map((v) => expect.closeTo(v, 5)));
    expect(d.maxDrawdownUsd).toBe(5);
    expect(d.endedWhy).toBe('Budget used up');
    expect(d.planName).toBe('Balanced');
  });

  it('singles out the best WINNING trade, never a loss', () => {
    expect(buildSessionShare(run()).best?.pnlUsd).toBe(3.1);
    const allLost = run({ trades: [trade({ at: 1, pnlUsd: -5 }), trade({ at: 2, pnlUsd: -5 })] });
    expect(buildSessionShare(allLost).best).toBeNull();
  });

  it('names a manual stop and a customized plan plainly', () => {
    const d = buildSessionShare(run({ stopReason: 'manual', preset: null }));
    expect(d.endedWhy).toBe('You stopped it');
    expect(d.planName).toBeNull();
  });
});

describe('sessionShareKinds', () => {
  it('always offers the session, the curve once it has a shape, the best call once something won', () => {
    expect(sessionShareKinds(buildSessionShare(run()))).toEqual(['session', 'curve', 'best_trade']);
    const oneWin = run({ trades: [trade({ at: 1, pnlUsd: 3 })] });
    expect(sessionShareKinds(buildSessionShare(oneWin))).toEqual(['session', 'best_trade']);
    const twoLosses = run({ trades: [trade({ at: 1, pnlUsd: -5 }), trade({ at: 2, pnlUsd: -5 })] });
    expect(sessionShareKinds(buildSessionShare(twoLosses))).toEqual(['session', 'curve']);
    const pending = run({ trades: [trade({ at: 1, pnlUsd: 0 })] });
    expect(sessionShareKinds(buildSessionShare(pending))).toEqual(['session']);
  });
});

describe('sessionShareText', () => {
  it('session: the record, the duration, the tag, no em-dash', () => {
    const t = sessionShareText(buildSessionShare(run()), 'session');
    expect(t).toContain('42 minutes');
    expect(t).toContain('3 trades, 2W/1L, +$0.30');
    expect(t).toContain('@skew_sui');
    expect(t).not.toMatch(NO_EMDASH);
  });

  it('session: a watch-mode run says so and never claims real money', () => {
    const t = sessionShareText(buildSessionShare(run({ dryRun: true })), 'session');
    expect(t).toContain('watch mode, no real money');
    expect(t).not.toContain('no popups');
  });

  it('session: counts trades still settling', () => {
    const d = buildSessionShare(run({ trades: [trade({ at: 1, pnlUsd: 3 }), trade({ at: 2, pnlUsd: 0 })] }));
    expect(sessionShareText(d, 'session')).toContain('1 still settling');
  });

  it('curve: the net, the settled count, and the worst dip', () => {
    const t = sessionShareText(buildSessionShare(run()), 'curve');
    expect(t).toContain('+$0.30 over 3 settled trades');
    expect(t).toContain('worst dip -$5.00');
    expect(t).not.toMatch(NO_EMDASH);
    const clean = run({ trades: [trade({ at: 1, pnlUsd: 2 }), trade({ at: 2, pnlUsd: 3 })] });
    expect(sessionShareText(buildSessionShare(clean), 'curve')).toContain('never went underwater');
  });

  it('best_trade: names the call, its odds, and what it paid', () => {
    const t = sessionShareText(buildSessionShare(run()), 'best_trade');
    expect(t).toContain('UP above $79,600 with 68% odds at entry, +$3.10 on a $5 stake');
    expect(t).toContain('session key placed it');
    expect(t).not.toMatch(NO_EMDASH);
  });

  it('best_trade: falls back to the session line when nothing won', () => {
    const d = buildSessionShare(run({ trades: [trade({ at: 1, pnlUsd: -5 })] }));
    expect(sessionShareText(d, 'best_trade')).toBe(sessionShareText(d, 'session'));
  });
});

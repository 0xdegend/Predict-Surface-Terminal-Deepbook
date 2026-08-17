import { describe, it, expect } from 'vitest';
import { formatAiContext, isPerformanceQuestion, type AiContext } from './ai';

describe('isPerformanceQuestion', () => {
  it('catches performance / track-record phrasings (→ offer the win-rate share)', () => {
    for (const q of [
      'How have I been performing lately?',
      'how am I doing',
      'what is my win rate',
      "how's my trading going",
      'am I profitable',
      'how many trades have I won',
      'am I on a streak',
      'how are my results',
    ]) {
      expect(isPerformanceQuestion(q), q).toBe(true);
    }
  });

  it('does not fire on non-performance reads', () => {
    for (const q of ['why is BTC moving', 'what is the fear and greed', 'set up a safe up bet', 'should I take a break today']) {
      expect(isPerformanceQuestion(q), q).toBe(false);
    }
  });
});

describe('formatAiContext', () => {
  it('empty context → a single honest fallback line', () => {
    expect(formatAiContext({})).toMatch(/no live context/i);
  });

  it('formats the known facts as short plain lines, omitting unknowns', () => {
    const ctx: AiContext = {
      spot: 64_912,
      lean: { pick: 'up', confidence: 'clear' },
      vol: 'calm',
      fearGreed: { value: 62, label: 'Greed' },
      nextExpiryMins: 4,
      wallet: { connected: true, hasAccount: true, balance: 12.4 },
      record: {
        total: 7,
        wins: 4,
        losses: 3,
        winRate: 4 / 7,
        realizedPnl: 18.4,
        streak: { won: false, count: 2 },
        last: { side: 'DOWN $64,650', result: 'lost', pnl: -5 },
      },
    };
    const out = formatAiContext(ctx);
    expect(out).toContain('$64,912');
    expect(out).toContain('leaning up (clear)');
    expect(out).toContain('62 out of 100 (Greed)');
    expect(out).toContain('$12.40 DUSDC');
    expect(out).toContain('57% win rate'); // 4/7 → 57%
    expect(out).toContain('DOWN $64,650');
    expect(out).toContain('-$5.00');
    // No positioning/oi lines were passed → not fabricated.
    expect(out).not.toMatch(/funding|open interest/i);
  });

  it('reflects a disconnected wallet and an empty track record honestly', () => {
    const out = formatAiContext({ wallet: { connected: false, hasAccount: false, balance: 0 }, record: { total: 0, wins: 0, losses: 0, winRate: 0, realizedPnl: 0 } });
    expect(out).toMatch(/not connected/i);
    expect(out).toMatch(/no settled bets/i);
  });

  it("lists today's scheduled events with their timing + a schedule-not-outcome caveat", () => {
    const out = formatAiContext({
      events: [
        { title: 'Fed Interest Rate Decision', when: 'in about 3 hours' },
        { title: 'US Jobless Claims', when: 'earlier today' },
      ],
    });
    expect(out).toContain('Fed Interest Rate Decision (in about 3 hours)');
    expect(out).toContain('US Jobless Claims (earlier today)');
    expect(out).toMatch(/not a prediction of the outcome/i);
  });

  it('omits the events line when none are passed', () => {
    expect(formatAiContext({ spot: 64_000 })).not.toMatch(/scheduled market events/i);
  });

  it('describes a rangebound read without a confidence suffix', () => {
    const out = formatAiContext({ lean: { pick: 'range', confidence: 'slight' } });
    expect(out).toMatch(/no clear direction/i);
    expect(out).not.toContain('(slight)');
  });

  it('renders saved memories so the LLM can answer questions about the trader', () => {
    const out = formatAiContext({ memories: ['your name is Degendev', 'my target is 5% a week'] });
    expect(out).toMatch(/remember about them/i);
    expect(out).toContain('- your name is Degendev');
    expect(out).toContain('- my target is 5% a week');
  });

  it('omits the memory block when none are passed, and caps a long note', () => {
    expect(formatAiContext({ spot: 64_000 })).not.toMatch(/remember about them/i);
    const long = 'x'.repeat(500);
    const out = formatAiContext({ memories: [long] });
    expect(out).toContain('x'.repeat(200));
    expect(out).not.toContain('x'.repeat(201));
  });
});

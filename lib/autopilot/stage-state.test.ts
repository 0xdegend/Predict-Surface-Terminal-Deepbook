import { describe, it, expect } from 'vitest';
import { stageView, REACTION_MS, PLACING_MS, type StageInput } from './stage-state';
import type { ScanSnapshot, ScanRow } from './scan';

const NOW = 1_700_000_000_000;

const row = (over: Partial<ScanRow> = {}): ScanRow => ({
  marketId: '0xmkt',
  expiry: NOW + 60_000,
  prob: 0.62,
  edge: 0.04,
  side: 'up',
  clears: true,
  k: 0,
  ...over,
});

const scan = (over: Partial<ScanSnapshot> = {}): ScanSnapshot => ({
  at: NOW,
  consideredCount: 4,
  offeredCount: 6,
  ranked: [],
  best: null,
  holdReason: null,
  ...over,
});

const base = (over: Partial<StageInput> = {}): StageInput => ({
  status: 'armed',
  ready: true,
  candidateCount: 4,
  scan: null,
  positions: [],
  lastPlacedAt: null,
  lastSettlement: null,
  now: NOW,
  ...over,
});

describe('stageView', () => {
  it('rests when the run is not armed, and never mimes a scan while stopped', () => {
    expect(stageView(base({ status: 'idle' })).beat).toBe('resting');
    // A stopped run still holds its last scan in the store; it must not keep presenting it.
    const stopped = stageView(base({ status: 'stopped', scan: scan({ ranked: [row()] }) }));
    expect(stopped.beat).toBe('resting');
    expect(stopped.focusMarketId).toBeNull();
    expect(stopped.energy).toBe(0);
  });

  it('treats a gas pause as a sit-down, not a stop', () => {
    const v = stageView(base({ status: 'paused' }));
    expect(v.beat).toBe('paused');
    expect(v.caption).toContain('picks back up on her own');
  });

  it('warms up before the engine is ready', () => {
    expect(stageView(base({ ready: false })).beat).toBe('warming');
    expect(stageView(base({ candidateCount: 0 })).beat).toBe('warming');
  });

  it('lines up on the top-ranked pick that cleared', () => {
    const v = stageView(base({ scan: scan({ ranked: [row({ marketId: '0xa', prob: 0.71 })] }) }));
    expect(v.beat).toBe('lining_up');
    expect(v.focusMarketId).toBe('0xa');
    expect(v.caption).toBe('Best value on the board: up at 71%.');
  });

  it('names a range pick as a range rather than by its side key', () => {
    const v = stageView(base({ scan: scan({ ranked: [row({ side: 'range', prob: 0.4 })] }) }));
    expect(v.caption).toBe('Best value on the board: a range at 40%.');
  });

  describe('scouting, the long quiet middle of a run', () => {
    it("stands on the best market on offer even when it did not clear, and says why", () => {
      const v = stageView(
        base({
          scan: scan({
            ranked: [],
            best: row({ marketId: '0xbest', prob: 0.41, clears: false }),
            holdReason: 'Best win chance on offer is under your 55% floor.',
          }),
        }),
      );
      expect(v.beat).toBe('scouting');
      // The whole point: waiting is not a blank screen. She has somewhere to be and a reason.
      expect(v.focusMarketId).toBe('0xbest');
      expect(v.caption).toBe('Best win chance on offer is under your 55% floor.');
    });

    it('falls back to the offered price when the engine gave no reason', () => {
      const v = stageView(base({ scan: scan({ best: row({ prob: 0.33, clears: false }) }) }));
      expect(v.caption).toBe('Best on offer is 33%. Nothing clears your rules yet.');
    });

    it('counts what it is watching when nothing at all is on offer', () => {
      expect(stageView(base({ scan: scan({ consideredCount: 3 }) })).caption).toBe(
        'Watching 3 markets. Nothing to buy yet.',
      );
      expect(stageView(base({ scan: scan({ consideredCount: 1 }) })).caption).toBe(
        'Watching one market. Nothing to buy yet.',
      );
      expect(stageView(base({ scan: scan({ consideredCount: 0 }) })).caption).toBe(
        'Waiting for a market to price.',
      );
    });

    it('ignores a stale scan rather than presenting an old ranking as current', () => {
      const old = scan({ at: NOW - 60_000, ranked: [row({ marketId: '0xstale' })] });
      const v = stageView(base({ scan: old }));
      expect(v.beat).not.toBe('lining_up');
      expect(v.focusMarketId).toBeNull();
    });
  });

  describe('settlement reactions', () => {
    it('holds a win and a loss for the same window, so the win cannot become the reward', () => {
      const won = stageView(base({ lastSettlement: { marketId: '0xw', won: true, at: NOW - 1_000 } }));
      const lost = stageView(base({ lastSettlement: { marketId: '0xl', won: false, at: NOW - 1_000 } }));
      expect(won.beat).toBe('won');
      expect(lost.beat).toBe('lost');
      expect(won.mood).toBe('won');
      expect(lost.mood).toBe('loss');

      const justOver = NOW - REACTION_MS - 1;
      expect(stageView(base({ lastSettlement: { marketId: '0xw', won: true, at: justOver } })).beat).not.toBe('won');
      expect(stageView(base({ lastSettlement: { marketId: '0xl', won: false, at: justOver } })).beat).not.toBe('lost');
    });

    it('outranks an open position so a resolved trade is not buried by the next one', () => {
      const v = stageView(
        base({
          positions: [{ marketId: '0xopen', expiry: NOW + 30_000, pnlUsd: 2 }],
          lastSettlement: { marketId: '0xdone', won: true, at: NOW - 500 },
        }),
      );
      expect(v.beat).toBe('won');
      expect(v.focusMarketId).toBe('0xdone');
    });

    it('keeps the loss reaction quieter than the win', () => {
      const won = stageView(base({ lastSettlement: { marketId: '0xw', won: true, at: NOW } }));
      const lost = stageView(base({ lastSettlement: { marketId: '0xl', won: false, at: NOW } }));
      expect(lost.energy).toBeLessThan(won.energy);
    });
  });

  describe('placing and holding', () => {
    it('shows the placement beat only briefly', () => {
      expect(stageView(base({ lastPlacedAt: NOW - 500 })).beat).toBe('placing');
      expect(stageView(base({ lastPlacedAt: NOW - PLACING_MS - 1 })).beat).not.toBe('placing');
    });

    it('focuses whichever open trade settles soonest', () => {
      const v = stageView(
        base({
          positions: [
            { marketId: '0xlate', expiry: NOW + 300_000, pnlUsd: 0 },
            { marketId: '0xsoon', expiry: NOW + 20_000, pnlUsd: 0 },
          ],
        }),
      );
      expect(v.beat).toBe('holding');
      expect(v.focusMarketId).toBe('0xsoon');
      expect(v.caption).toBe('Holding 2 trades to settlement.');
    });

    it('says "one trade" rather than "1 trades"', () => {
      const v = stageView(base({ positions: [{ marketId: '0xa', expiry: NOW + 10_000, pnlUsd: 0 }] }));
      expect(v.caption).toBe('Holding one trade to settlement.');
    });
  });

  it('never emits an em-dash in a caption', () => {
    const captions = [
      stageView(base({ status: 'idle' })),
      stageView(base({ status: 'stopped' })),
      stageView(base({ status: 'paused' })),
      stageView(base({ ready: false })),
      stageView(base({ scan: scan({ ranked: [row()] }) })),
      stageView(base({ scan: scan({ best: row({ clears: false }) }) })),
      stageView(base({ scan: scan({ consideredCount: 0 }) })),
      stageView(base({ positions: [{ marketId: '0xa', expiry: NOW, pnlUsd: 0 }] })),
      stageView(base({ lastPlacedAt: NOW })),
      stageView(base({ lastSettlement: { marketId: '0xa', won: true, at: NOW } })),
      stageView(base({ lastSettlement: { marketId: '0xa', won: false, at: NOW } })),
    ].map((v) => v.caption);
    for (const c of captions) expect(c).not.toContain('—');
  });
});

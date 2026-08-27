import { describe, it, expect } from 'vitest';
import { buildRunTape, type TapeLogLine, type TapeOpen, type TapeSettled } from './run-tape';

const ARMED = 1_000_000;
const MIN = 60_000;

const tape = (over: Partial<Parameters<typeof buildRunTape>[0]> = {}) =>
  buildRunTape({ armedAt: ARMED, armDurationMs: 15 * MIN, open: [], settled: [], log: [], ...over });

const openPos = (over: Partial<TapeOpen> = {}): TapeOpen => ({
  marketId: 'm1',
  side: 'up',
  openedAt: ARMED + MIN,
  expiry: ARMED + 5 * MIN,
  sizeUsd: 5,
  dryRun: false,
  ...over,
});

const settledTrade = (over: Partial<TapeSettled> = {}): TapeSettled => ({
  marketId: 'm1',
  side: 'up',
  at: ARMED + MIN,
  outcome: 'won',
  stake: 5,
  pnlUsd: 4.2,
  ...over,
});

describe('buildRunTape', () => {
  it('lays the axis over the run, and stretches it only when something overran', () => {
    expect(tape().endAt).toBe(ARMED + 15 * MIN);
    expect(tape().plannedEnd).toBe(1);

    // A trade that expires after the run's own clock runs out must stay on the tape.
    const over = tape({ open: [openPos({ expiry: ARMED + 20 * MIN })] });
    expect(over.endAt).toBe(ARMED + 20 * MIN);
    expect(over.plannedEnd).toBeCloseTo(0.75, 5);
  });

  it('places a bar across the fraction of the run it was alive for', () => {
    const t = tape({ open: [openPos({ openedAt: ARMED + 3 * MIN, expiry: ARMED + 6 * MIN })] }).trades[0];
    expect(t.from).toBeCloseTo(0.2, 5);
    expect(t.to).toBeCloseTo(0.4, 5);
    expect(t.outcome).toBe('open');
  });

  it('takes a settled trade’s end from the log, which is the only place it is recorded', () => {
    const log: TapeLogLine[] = [
      { kind: 'placed', at: ARMED + 3 * MIN, text: 'placed', marketId: 'm1' },
      { kind: 'settled', at: ARMED + 9 * MIN, text: 'Won $4.20', marketId: 'm1' },
    ];
    const t = tape({ settled: [settledTrade({ at: ARMED + 3 * MIN })], log }).trades[0];
    expect(t.from).toBeCloseTo(0.2, 5);
    expect(t.to).toBeCloseTo(0.6, 5);
  });

  it('leaves a trade that never settled as a point instead of inventing a length', () => {
    const t = tape({ settled: [settledTrade({ outcome: 'pending', pnlUsd: 0 })] }).trades[0];
    expect(t.from).toBe(t.to);
    expect(t.label).toMatch(/never settled/);
  });

  it('stacks overlapping bets into lanes and reuses a lane once it is free', () => {
    const t = tape({
      open: [
        openPos({ marketId: 'a', openedAt: ARMED, expiry: ARMED + 5 * MIN }),
        openPos({ marketId: 'b', openedAt: ARMED + MIN, expiry: ARMED + 4 * MIN }),
        openPos({ marketId: 'c', openedAt: ARMED + 6 * MIN, expiry: ARMED + 8 * MIN }),
      ],
    });
    const lane = (id: string) => t.trades.find((x) => x.marketId === id)!.lane;
    expect(lane('a')).toBe(0);
    expect(lane('b')).toBe(1); // overlaps a
    expect(lane('c')).toBe(0); // a is done by then
    expect(t.lanes).toBe(2);
  });

  it('never grows past four lanes, however many bets overlap', () => {
    const open = Array.from({ length: 9 }, (_, i) =>
      openPos({ marketId: `m${i}`, openedAt: ARMED + i * 1_000, expiry: ARMED + 10 * MIN }),
    );
    const t = tape({ open });
    expect(t.lanes).toBe(4);
    expect(Math.max(...t.trades.map((x) => x.lane))).toBe(3);
  });

  it('says the whole trade in one line, with plain money and no em dash', () => {
    expect(tape({ settled: [settledTrade()] }).trades[0].label).toBe('UP · $5 · won +$4.20');
    expect(tape({ settled: [settledTrade({ side: 'down', outcome: 'lost', pnlUsd: -5 })] }).trades[0].label).toBe(
      'DOWN · $5 · lost -$5',
    );
    expect(tape({ open: [openPos({ side: 'range', sizeUsd: 12.5 })] }).trades[0].label).toBe(
      'RANGE · $12.50 · still open',
    );
    for (const t of tape({ settled: [settledTrade()] }).trades) expect(t.label).not.toMatch(/[—–]/);
  });

  it('keeps the moments Kelly looked and passed, in order, and nothing else from the log', () => {
    const log: TapeLogLine[] = [
      { kind: 'held', at: ARMED + 9 * MIN, text: 'Odds too thin' },
      { kind: 'armed', at: ARMED, text: 'Autopilot armed' },
      { kind: 'held', at: ARMED + 3 * MIN, text: 'Cooling down' },
    ];
    const holds = tape({ log }).holds;
    expect(holds.map((h) => h.text)).toEqual(['Cooling down', 'Odds too thin']);
    expect(holds[0].pos).toBeCloseTo(0.2, 5);
  });

  it('survives a run with nothing in it at all', () => {
    const t = tape();
    expect(t.trades).toEqual([]);
    expect(t.holds).toEqual([]);
    expect(t.lanes).toBe(1); // still has a track to draw
    expect(t.endAt).toBeGreaterThan(t.startAt);
  });
});

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { tapeBounds, tapeSnapshotAt, type SviTape, type SviSample } from './v2-svi-tape';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

const SVI: [number, number, number, number, number] = [0.04, 0.1, -0.2, 0.0, 0.1];

/** A sample observed at `t` for a market expiring at `e`, forward `f`. */
const s = (t: number, f: number, e: number): SviSample => ({ t, f, e, p: [...SVI] });

const input = (id: string, expiry: number, forward: number): SmileInput => ({
  oracle: { oracle_id: id, expiry, underlying_asset: 'BTC' } as unknown as Oracle,
  svi: { a: SVI[0], b: SVI[1], rho: SVI[2], m: SVI[3], sigma: SVI[4] },
  forward,
});

describe('tapeBounds', () => {
  it('is null while the tape is empty', () => {
    expect(tapeBounds({})).toBeNull();
  });

  it('is null when there is only a single instant (nothing to scrub through)', () => {
    expect(tapeBounds({ a: [s(1_000, 100, 9_000)] })).toBeNull();
  });

  it('spans the earliest and latest observation across every market', () => {
    const tape: SviTape = {
      a: [s(1_000, 100, 90_000), s(5_000, 101, 90_000)],
      b: [s(3_000, 100, 90_000), s(9_000, 102, 90_000)],
    };
    expect(tapeBounds(tape)).toEqual({ tMin: 1_000, tMax: 9_000 });
  });
});

describe('tapeSnapshotAt', () => {
  it('lands exactly on a recorded observation at its own timestamp', () => {
    const tape: SviTape = {
      a: [s(1_000, 100, 90_000), s(5_000, 200, 90_000), s(9_000, 300, 90_000)],
    };
    expect(tapeSnapshotAt(tape, 5_000)[0].forward).toBe(200);
    expect(tapeSnapshotAt(tape, 9_000)[0].forward).toBe(300);
  });

  it('INTERPOLATES between the bracketing observations (a stepped scrub is a slideshow)', () => {
    const tape: SviTape = { a: [s(5_000, 200, 90_000), s(9_000, 300, 90_000)] };
    // A quarter of the way from 5s→9s ⇒ a quarter of the way from 200→300.
    expect(tapeSnapshotAt(tape, 6_000)[0].forward).toBeCloseTo(225, 6);
    expect(tapeSnapshotAt(tape, 7_000)[0].forward).toBeCloseTo(250, 6);
  });

  it('interpolates the SVI params too, so the smile morphs continuously', () => {
    const lo: SviSample = { t: 0, f: 100, e: 90_000, p: [0.0, 0.0, 0.0, 0.0, 0.0] };
    const hi: SviSample = { t: 10, f: 100, e: 90_000, p: [1.0, 1.0, 1.0, 1.0, 1.0] };
    const [row] = tapeSnapshotAt({ a: [lo, hi] }, 5);
    expect(row.svi.a).toBeCloseTo(0.5, 6);
    expect(row.svi.rho).toBeCloseTo(0.5, 6);
    expect(row.svi.sigma).toBeCloseTo(0.5, 6);
  });

  it('holds the last observation after the end of the tape (no extrapolation)', () => {
    const tape: SviTape = { a: [s(1_000, 100, 90_000), s(5_000, 200, 90_000)] };
    expect(tapeSnapshotAt(tape, 50_000)[0].forward).toBe(200);
  });

  it('omits a market we had not started recording yet', () => {
    const tape: SviTape = { a: [s(5_000, 200, 90_000)] };
    expect(tapeSnapshotAt(tape, 1_000)).toEqual([]);
  });

  it('drops markets that had ALREADY expired at the scrub moment', () => {
    // The IV-explosion guard: a market past expiry has frozen w while T→0, so
    // IV = √(w/T) blows up and wrecks the mesh's height/colour normalization.
    const tape: SviTape = {
      dead: [s(1_000, 100, 2_000)], // expired at t=2s
      live: [s(1_000, 100, 90_000)],
    };
    const out = tapeSnapshotAt(tape, 50_000);
    expect(out.map((i) => i.oracle.oracle_id)).toEqual(['live']);
  });

  it('KEEPS a market that has since expired but was live at the scrub moment', () => {
    // This is the whole point of storing expiry per-sample: v2 markets roll every
    // ~minute, so rewinding must resurrect the markets that were live back then.
    const tape: SviTape = { rolled: [s(1_000, 100, 60_000)] };
    expect(tapeSnapshotAt(tape, 10_000)).toHaveLength(1); // was live at t=10s
    expect(tapeSnapshotAt(tape, 80_000)).toHaveLength(0); // long gone by t=80s
  });

  it('rebuilds the SVI params it recorded', () => {
    const tape: SviTape = { a: [s(1_000, 123.5, 90_000)] };
    const [row] = tapeSnapshotAt(tape, 1_000);
    expect(row.forward).toBe(123.5);
    expect(row.svi).toEqual({ a: 0.04, b: 0.1, rho: -0.2, m: 0.0, sigma: 0.1 });
  });
});

describe('recordTape', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('captures a fresh observation and exposes it via the snapshot', async () => {
    const m = await import('./v2-svi-tape');
    m.recordTape([input('a', 90_000, 100)], 1_000);
    expect(m.tapeSnapshotAt(m.getTapeSnapshot(), 1_000)[0].forward).toBe(100);
  });

  it('ignores a repolled pricer that has not moved (identical forward + SVI)', async () => {
    const m = await import('./v2-svi-tape');
    m.recordTape([input('a', 90_000, 100)], 1_000);
    const first = m.getTapeSnapshot();
    // Same numbers, well past the min gap → no information, so no new sample.
    m.recordTape([input('a', 90_000, 100)], 30_000);
    expect(m.getTapeSnapshot()).toBe(first); // identity unchanged ⇒ no re-render
    expect(m.getTapeSnapshot().a).toHaveLength(1);
  });

  it('records a moved forward, and bounds then span the window', async () => {
    const m = await import('./v2-svi-tape');
    m.recordTape([input('a', 90_000, 100)], 1_000);
    m.recordTape([input('a', 90_000, 101)], 30_000);
    expect(m.getTapeSnapshot().a).toHaveLength(2);
    expect(m.tapeBounds(m.getTapeSnapshot())).toEqual({ tMin: 1_000, tMax: 30_000 });
  });

  it('throttles bursts — a second observation inside the min gap is dropped', async () => {
    const m = await import('./v2-svi-tape');
    m.recordTape([input('a', 90_000, 100)], 1_000);
    m.recordTape([input('a', 90_000, 999)], 1_500); // moved, but only 500ms later
    expect(m.getTapeSnapshot().a).toHaveLength(1);
  });
});

/**
 * The double-count guard.
 *
 * With one snapshot this rule was safe by accident and written as prose. With two it is the
 * difference between a correct board and one that reports exactly double the points, volume
 * and trade count for every trader who has traded — silently, with nothing to see in a log
 * and nothing to catch in a typecheck. These tests exist so that rule can never quietly
 * revert to a version flag.
 */
import { describe, it, expect } from 'vitest';
import { carriedSnapshots } from './seed-registry';
import { LEGACY_SEEDS, LEGACY_OWNERS, mergeLegacyCarryover } from './legacy-carryover';
import { ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import seed624 from './legacy-points-6-24.json';
import seed806 from './legacy-points-8-06.json';
import type { V2LeaderboardRow } from './v2';

const seed = (deployment: string) => ({ deployment, capturedAt: '2026-01-01T00:00:00.000Z' });
const ALL = [seed('6-24'), seed('8-06'), seed('8-21')];

describe('carriedSnapshots', () => {
  it('never overlays a snapshot on the deployment it was captured from', () => {
    // The whole point. Running ON 8-06 with the 8-06 seed loaded would add each trader's
    // own live trades to themselves.
    expect(carriedSnapshots(ALL, '8-06').map((s) => s.deployment)).toEqual(['6-24', '8-21']);
    expect(carriedSnapshots(ALL, '6-24').map((s) => s.deployment)).toEqual(['8-06', '8-21']);
  });

  it('chains every other snapshot, so standing accumulates across releases', () => {
    // A trader who played 6-24 and 8-06 must arrive on 8-21 carrying both, not the later one.
    expect(carriedSnapshots(ALL, '8-21').map((s) => s.deployment)).toEqual(['6-24', '8-06']);
  });

  it('is a no-op when nothing has been retired yet', () => {
    expect(carriedSnapshots([seed('6-24')], '6-24')).toEqual([]);
  });
});

describe('the configured carryover', () => {
  it('excludes the deployment we are actually running on', () => {
    // Reads the REAL registry rather than a fixture, so adding a seed and forgetting the
    // guard fails here rather than on the live board.
    const carried = LEGACY_SEEDS.map((s) => s.deployment);
    expect(carried, `a seed for the active deployment ${ACTIVE_V2_DEPLOYMENT} is being overlaid`).not.toContain(
      ACTIVE_V2_DEPLOYMENT,
    );
    expect(carried.length, 'no snapshots carried at all — standing would reset').toBeGreaterThan(0);
  });

  it('lists each carried wallet exactly once, however many releases it played', () => {
    // The owners feed a fan-out in the indexer; a duplicate there is wasted requests, and a
    // duplicate in the merge map would be a double-count by another route.
    expect(new Set(LEGACY_OWNERS).size).toBe(LEGACY_OWNERS.length);
    expect(LEGACY_OWNERS.every((o) => o === o.toLowerCase())).toBe(true);
  });

  it('adds carried totals to a live row instead of replacing them', () => {
    const owner = LEGACY_OWNERS[0];
    const live: V2LeaderboardRow[] = [{ owner, points: 10, volume: 5, trades: 2 }];
    const merged = mergeLegacyCarryover(live);
    const row = merged.find((r) => r.owner.toLowerCase() === owner);
    expect(row).toBeTruthy();
    // The live 10 points are still in there, and the carried amount is attributed so the UI
    // can say where it came from.
    expect(row!.points).toBeGreaterThan(10);
    expect(row!.legacyPoints).toBe(row!.points - 10);
    expect(row!.trades).toBeGreaterThan(2);
  });

  it('keeps a returning trader who has not traded yet on the board', () => {
    const merged = mergeLegacyCarryover([]);
    expect(merged.length).toBe(LEGACY_OWNERS.length);
    expect(merged.every((r) => r.viaSkew)).toBe(true);
  });
});

describe('the snapshots themselves are independent', () => {
  it('holds each seed to its own deployment only, so chaining cannot double-count', () => {
    // Chaining is only correct if each capture contains ONE deployment's trades. The overlay
    // is applied at read time in /api/v2/leaderboard, never baked into a seed — but a future
    // capture taken from the API response instead of from chain would bake it in, and then
    // adding 6-24 to an 8-06 seed that already contained 6-24 would double the older half.
    // Nothing about that would look wrong: the board would still render, still rank, and
    // just be quietly generous to exactly the returning traders it was meant to protect.
    //
    // The evidence is arithmetic. A contaminated 8-06 seed would have to be at least as
    // large as 6-24 for every wallet in both, because it would literally contain those
    // points. At least one wallet is smaller, which a contaminated seed cannot be.
    const s624 = seed624 as unknown as { rows: { owner: string; points: number }[] };
    const s806 = seed806 as unknown as { rows: { owner: string; points: number }[] };
    const points624 = new Map(s624.rows.map((r) => [r.owner.toLowerCase(), r.points]));
    const inBoth = s806.rows.filter((r) => points624.has(r.owner.toLowerCase()));

    expect(inBoth.length, 'no wallet played both releases — this check proves nothing').toBeGreaterThan(0);
    const smaller = inBoth.filter((r) => r.points < points624.get(r.owner.toLowerCase())!);
    expect(
      smaller.length,
      'every shared wallet scores at least its 6-24 total on 8-06 — the 8-06 seed may have been ' +
        'captured from the carried board rather than from chain',
    ).toBeGreaterThan(0);
  });
});

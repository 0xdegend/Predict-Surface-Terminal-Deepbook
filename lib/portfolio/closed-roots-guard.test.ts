import { describe, it, expect } from 'vitest';
import {
  createClosedRootsGuard,
  type ClosedRootsPersistence,
} from './closed-roots-guard';

/** A fake persistence that keeps the map in a plain object, so tests never touch
 *  localStorage but still exercise hydrate/save (the reload path). */
function fakeStore(seed: Record<string, number> = {}) {
  const box = { data: { ...seed } };
  const persistence: ClosedRootsPersistence = {
    load: () => ({ ...box.data }),
    save: (map) => {
      box.data = { ...map };
    },
  };
  return { box, persistence };
}

describe('createClosedRootsGuard', () => {
  it('remembers a root once marked closed, and stays false for unknown/empty roots', () => {
    const g = createClosedRootsGuard();
    expect(g.isClosed('A')).toBe(false);
    g.markClosed('A');
    expect(g.isClosed('A')).toBe(true);
    expect(g.isClosed('B')).toBe(false);
    expect(g.isClosed('')).toBe(false);
  });

  it('is a no-op for an empty root', () => {
    const { box, persistence } = fakeStore();
    const g = createClosedRootsGuard({ persistence });
    g.markClosed('');
    expect(g.isClosed('')).toBe(false);
    expect(box.data).toEqual({}); // nothing persisted
  });

  it('forgets a root once its TTL has elapsed (storage hygiene, not correctness)', () => {
    let t = 1_000;
    const g = createClosedRootsGuard({ ttlMs: 100, now: () => t });
    g.markClosed('A');
    expect(g.isClosed('A')).toBe(true);
    t += 101; // past the TTL
    expect(g.isClosed('A')).toBe(false);
  });

  it('caps the set, evicting the oldest closes first', () => {
    let t = 0;
    const g = createClosedRootsGuard({ cap: 2, now: () => (t += 1) });
    g.markClosed('A'); // t=1
    g.markClosed('B'); // t=2
    g.markClosed('C'); // t=3 -> over cap, A (oldest) evicted
    expect(g.isClosed('A')).toBe(false);
    expect(g.isClosed('B')).toBe(true);
    expect(g.isClosed('C')).toBe(true);
  });

  it('persists on close and re-hydrates on the next guard (the reload path)', () => {
    const { box, persistence } = fakeStore();
    const first = createClosedRootsGuard({ persistence });
    first.markClosed('A');
    expect(box.data).toHaveProperty('A'); // written through

    // A fresh guard over the same store (a page reload) still knows A is closed,
    // so the very first fold after reload suppresses the paid position.
    const afterReload = createClosedRootsGuard({ persistence });
    expect(afterReload.isClosed('A')).toBe(true);
  });

  it('drops already-expired entries when hydrating', () => {
    const now = 10_000;
    const { persistence } = fakeStore({ FRESH: now - 10, STALE: now - 10_000 });
    const g = createClosedRootsGuard({ ttlMs: 1_000, now: () => now, persistence });
    expect(g.isClosed('FRESH')).toBe(true);
    expect(g.isClosed('STALE')).toBe(false);
  });
});

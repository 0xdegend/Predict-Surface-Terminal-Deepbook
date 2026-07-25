'use client';

/**
 * ExpectedMoveBand — the surface's ±1σ expected range to the front expiry, with a
 * marker for where the price sits now. "About 2 in 3 of the time it lands in here."
 */
import { num } from '@/lib/format';
import { Term } from './vocab';
import type { ExpectedMove, AssetConfig } from '@/lib/insights';

export function ExpectedMoveBand({ em, spot }: { em: ExpectedMove | null; spot: number | null; asset: AssetConfig }) {
  if (!em) return null;
  const pct = (em.sigma * 100).toFixed(2);
  // Marker position within [low, high], clamped so a big move still renders.
  const pos = spot != null ? Math.max(0, Math.min(1, (spot - em.lowPrice) / (em.highPrice - em.lowPrice))) : 0.5;

  return (
    <div className="glass rounded-lg p-4">
      <div className="text-[10.5px] uppercase tracking-wider text-text-3">
        <Term plain="Expected range by next expiry (about 2 in 3 chance)" pro="1σ expected move · front expiry" />
      </div>
      <div className="relative mb-2 mt-6 h-2.5 rounded-md border border-(--accent-line) bg-(--accent-soft)">
        <div className="absolute top-[-6px] h-[22px] w-0.5 rounded bg-text-1" style={{ left: `${pos * 100}%` }}>
          <span className="absolute left-1/2 top-[-3px] h-2 w-2 -translate-x-1/2 rounded-full bg-text-1" />
        </div>
      </div>
      <div className="flex justify-between font-mono text-[12px] tabular-nums text-text-2">
        <span>${num(em.lowPrice, 0)}</span>
        <span>${num(em.highPrice, 0)}</span>
      </div>
      <div className="mt-2.5 text-[12px] text-text-2">
        <Term plain={`A move of about ±${pct}% either way`} pro={`±${pct}% · 1σ`} />
      </div>
    </div>
  );
}

'use client';

/**
 * ExpectedMoveBand — the surface's ±1σ expected range to the SELECTED expiry, with a
 * marker for where the price sits now. "About 2 in 3 of the time it lands in here."
 *
 * It used to read the FRONT expiry no matter which one the page was on, which put a
 * "±0.02%, $76,957 to $76,991" band above a ladder priced to a different clock — and
 * disagreed with the share card, which was already computing it off the selection. It
 * now follows the ladder, and names the horizon it is talking about.
 */
import Link from 'next/link';
import { LuMessageSquare } from 'react-icons/lu';
import { num } from '@/lib/format';
import { Term } from './vocab';
import { ShareXButton } from '../share/share-x-button';
import type { ExpectedMove, AssetConfig } from '@/lib/insights';

export function ExpectedMoveBand({
  em,
  spot,
  horizon,
  onShare,
}: {
  em: ExpectedMove | null;
  spot: number | null;
  /** The selected expiry in words ("4 min"), so the card names its own horizon. */
  horizon?: string | null;
  asset: AssetConfig;
  onShare?: () => void;
}) {
  if (!em) return null;
  const pct = (em.sigma * 100).toFixed(2);
  // Marker position within [low, high], clamped so a big move still renders.
  const pos = spot != null ? Math.max(0, Math.min(1, (spot - em.lowPrice) / (em.highPrice - em.lowPrice))) : 0.5;

  return (
    <div className="glass rounded-lg p-4">
      <div className="flex items-start justify-between gap-2">
        {/* No "1σ" in the Pro label: this row is `uppercase`, which renders σ as Σ. The
            sigma still appears in the footnote below, which is not transformed. */}
        <div className="text-[10.5px] uppercase tracking-wider text-text-3">
          {horizon ? (
            <Term plain={`Expected range in ${horizon} (about 2 in 3 chance)`} pro={`Expected move · ${horizon}`} />
          ) : (
            <Term plain="Expected range by expiry (about 2 in 3 chance)" pro="Expected move" />
          )}
        </div>
        {onShare && <ShareXButton onClick={onShare} label="Share the expected range" />}
      </div>
      <div className="relative mb-2 mt-7 h-3">
        {/* Frosted glass track: translucent accent fill, a center-weighted glow
            (densest where the price most likely lands), a top sheen, and an inset
            shadow for real depth. */}
        <div className="absolute inset-0 overflow-hidden rounded-full border border-(--accent-line) bg-(--accent-soft) shadow-[inset_0_-2px_6px_rgba(0,0,0,0.5)]">
          <div className="absolute inset-0 bg-[radial-gradient(130%_160%_at_50%_50%,rgba(77,214,176,0.28),transparent_72%)]" />
          <div className="pointer-events-none absolute inset-x-0 top-0 h-1/2 bg-linear-to-b from-white/15 to-transparent" />
        </div>
        {/* "Now" marker: a glassy needle with a glowing cap dot. */}
        <div
          className="absolute top-1/2 z-10 h-5.5 w-0.75 -translate-x-1/2 -translate-y-1/2 rounded-full bg-linear-to-b from-white via-white to-white/55 shadow-[0_0_10px_rgba(255,255,255,0.4)]"
          style={{ left: `${pos * 100}%` }}
        >
          <span className="absolute left-1/2 -top-1.5 h-2.5 w-2.5 -translate-x-1/2 rounded-full border border-white/70 bg-white shadow-[0_0_12px_3px_rgba(77,214,176,0.5)]" />
        </div>
      </div>
      <div className="flex justify-between font-mono text-[12px] tabular-nums text-text-2">
        <span>${num(em.lowPrice, 0)}</span>
        <span>${num(em.highPrice, 0)}</span>
      </div>
      <div className="mt-2.5 flex items-center justify-between gap-2">
        <div className="text-[12px] text-text-2">
          <Term plain={`A move of about ±${pct}% either way`} pro={`±${pct}% · 1σ`} />
        </div>
        {/* Bridge to Kelly: she recommends a range bet off this exact expected move,
            so the read here turns straight into a tradeable band. */}
        <Link
          href="/v2/copilot?ask=Recommend%20a%20range"
          className="inline-flex shrink-0 items-center gap-1 rounded-full border border-(--accent-line) bg-(--accent-soft) px-2.5 py-1 text-[10.5px] font-medium text-accent transition-colors hover:bg-up/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
        >
          <LuMessageSquare size={11} />
          Ask Kelly for a range
        </Link>
      </div>
    </div>
  );
}

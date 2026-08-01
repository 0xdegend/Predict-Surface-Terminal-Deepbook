'use client';

/**
 * StaleFeedOverlay — a blur + small "live prices delayed" chip shown over the
 * price chart and the trade ticket when the upstream BTC spot feed is frozen
 * (see useSpotFeedStale). It is a self-contained LEAF that owns the 1s staleness
 * tick, so mounting it never re-renders the (heavier) chart/ticket around it, and
 * it renders NOTHING while the feed is healthy.
 *
 * The parent must be a positioned box (`relative`). The overlay captures pointer
 * events, which also blocks placing a trade against a stale quote. Honest, not a
 * takeover: a light blur + one chip, so the stale content still reads underneath.
 */
import { useSpotFeedStale } from '@/lib/hooks/use-feed-stale';

export function StaleFeedOverlay({ label = 'Live prices delayed' }: { label?: string }) {
  const { stale } = useSpotFeedStale();
  if (!stale) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      className="absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-bg-0/25 backdrop-blur-[3px]"
    >
      <span className="inline-flex items-center rounded-full border border-warn/40 bg-bg-1/90 px-2.5 py-1 text-[11px] font-medium text-warn shadow-lg backdrop-blur-sm">
        {label}
      </span>
    </div>
  );
}

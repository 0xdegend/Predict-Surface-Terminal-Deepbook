'use client';

/**
 * V2SpotTape — a live BTC spot readout for the new deployment, in the nav on every
 * page. Polled every 250ms so the nav price is the MOST live thing on screen (the feed
 * writes ~4-5x/sec, so this tracks it about as tightly as the data allows — a touch
 * livelier than the chart's ~350ms stream cadence). A straight fast poll beats wiring
 * the checkpoint stream here: 250ms is already faster than the stream's debounce, so the
 * stream would add nothing, and this keeps it off the non-trade pages. The interval
 * pauses while the tab is unfocused (React Query default), so it isn't hammering in the
 * background. A quiet readout: just the asset, the price, and a tick arrow (green up /
 * red down). The digits ODOMETER-ROLL to each new tick (RollingNumber) — a pure visual
 * slide, so the price shown is always the real, current value with zero delay. Read-only.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { RollingNumber } from '@/app/_components/ui/rolling-number';
import { predictV2Config } from '@/config/predict';

export function V2SpotTape() {
  const { data } = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(predictV2Config.asset.pythFeedId),
    refetchInterval: 250, // sub-second: track the ~4-5/s feed as tightly as it moves
  });
  const spot = pythSpot(data ?? null);

  // Track last spot + last move direction. React's "adjust state during render"
  // pattern (guarded so it converges) — no effect, no ref-in-render. `dir` persists
  // between ticks so the tick colour holds until the next change.
  const [last, setLast] = useState<number | null>(null);
  const [dir, setDir] = useState<'up' | 'down' | 'flat'>('flat');
  if (spot != null && spot !== last) {
    setDir(last == null ? 'flat' : spot > last ? 'up' : 'down');
    setLast(spot);
  }

  const color = dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-1';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';

  // Whole dollars on phones (the nav bar is tight there), cents on ≥sm. Pin 2 decimals
  // on ≥sm so the digit count (and width) holds steady as the odometer rolls.
  const mobileText = spot != null ? `$${Math.round(spot).toLocaleString()}` : '—';
  const deskText =
    spot != null ? `$${spot.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : '—';

  return (
    <div className="flex items-center gap-2 rounded-lg bg-white/2 px-2.5 py-2 backdrop-blur-md sm:px-3">
      <span className="eyebrow">BTC</span>
      <span className={`font-mono text-[14px] tabular-nums sm:text-[15px] ${color}`} aria-label={deskText}>
        <span className="sm:hidden">
          <RollingNumber text={mobileText} />
        </span>
        <span className="hidden sm:inline">
          <RollingNumber text={deskText} />
        </span>
        <span className="ml-1 text-[11px]" aria-hidden="true">
          {arrow}
        </span>
      </span>
    </div>
  );
}

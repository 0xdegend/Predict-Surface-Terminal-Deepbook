'use client';

/**
 * V2SpotTape — a live BTC spot readout for the new deployment, polled ~1.5s from
 * the propbook oracle indexer. A quiet readout: just the asset, the price, and a
 * tick arrow (green up / red down). The digits ODOMETER-ROLL to each new tick
 * (RollingNumber) — a pure visual slide, so the price shown is always the real,
 * current value with zero animation delay. Read-only.
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
    refetchInterval: 1500,
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

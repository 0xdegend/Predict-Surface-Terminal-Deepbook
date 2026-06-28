'use client';

/**
 * V2SpotTape — a live BTC spot readout for the new deployment, polled ~1.5s from
 * the propbook oracle indexer. Framed for the fast 1-minute markets; ticks green
 * up / red down. Read-only.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';

export function V2SpotTape() {
  const { data } = useQuery({
    queryKey: qkV2.pythLatest,
    queryFn: () => getPythLatest(predictV2Config.asset.pythFeedId),
    refetchInterval: 1500,
  });
  const spot = pythSpot(data ?? null);

  // Track last spot + last move direction. React's "adjust state during render"
  // pattern (guarded so it converges) — no effect, no ref-in-render. `dir`
  // persists between ticks so the tick colour holds until the next change.
  const [last, setLast] = useState<number | null>(null);
  const [dir, setDir] = useState<'up' | 'down' | 'flat'>('flat');
  if (spot != null && spot !== last) {
    setDir(last == null ? 'flat' : spot > last ? 'up' : 'down');
    setLast(spot);
  }

  const color = dir === 'up' ? 'text-up' : dir === 'down' ? 'text-down' : 'text-text-1';
  const arrow = dir === 'up' ? '▲' : dir === 'down' ? '▼' : '·';

  return (
    <div className="flex items-center gap-2 rounded-lg bg-white/2 px-3 py-2 backdrop-blur-md">
      <span className="eyebrow">BTC · live</span>
      <span className={`font-mono text-[15px] tabular-nums ${color}`}>
        {spot != null ? `$${spot.toLocaleString(undefined, { maximumFractionDigits: 2 })}` : '—'}
        <span className="ml-1 text-[11px]">{arrow}</span>
      </span>
      <span className="ml-auto font-mono text-[10px] text-text-3">1-minute markets</span>
    </div>
  );
}

'use client';

import { useEffect, useRef, useState } from 'react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getLatestPrices, qk } from '@/lib/api/client';
import { useFrontOracleId } from '@/lib/hooks/use-front-oracle';
import { toFloat } from '@/config/scale';
import { price, timeUTC } from '@/lib/format';
import type { PriceEvent } from '@/lib/api/types';

export type MarketDiagnostics = {
  statusOk: boolean;
  checkpointLag: number;
  timeLagS: number;
  tradingPaused: boolean | null;
  quoteSymbol: string;
  activeOracles: number;
};

/**
 * The Live Market Chip — the centerpiece of the redesigned header (§redesign).
 * Collapses the old second status bar into one glass capsule: live spot/forward
 * tape on its face, full protocol diagnostics behind a popover. One signal, no
 * noise. Client-only (live polling + browser popover).
 */
export function MarketChip({
  oracleId,
  underlying,
  initial,
  diagnostics,
}: {
  oracleId: string;
  underlying: string;
  initial: PriceEvent | null;
  diagnostics: MarketDiagnostics;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const prevSpot = useRef<number | null>(null);
  const [tick, setTick] = useState<'up' | 'down' | null>(null);

  // Follow the live front oracle, not the one pinned at server-render — otherwise
  // the tape freezes once that market settles (showed a stale spot vs the table).
  const liveOracleId = useFrontOracleId(oracleId);

  const { data, isFetching } = useQuery({
    queryKey: qk.latestPrices(liveOracleId),
    queryFn: ({ signal }) => getLatestPrices(liveOracleId, { signal }),
    // The SSR `initial` belongs to the originally-pinned oracle; only seed with
    // it while we're still on that one. When the front advances, keep the last
    // shown price (no blank flash) until the new oracle's first tick lands.
    initialData: liveOracleId === oracleId ? (initial ?? undefined) : undefined,
    placeholderData: keepPreviousData,
    refetchInterval: 1000,
  });

  const spot = data ? toFloat(data.spot) : null;
  const forward = data ? toFloat(data.forward) : null;
  const paused = diagnostics.tradingPaused === true;

  // Flash the spot mint/coral on tick, then settle (no layout shift — tnum).
  useEffect(() => {
    if (spot == null) return;
    if (prevSpot.current != null && spot !== prevSpot.current) {
      setTick(spot > prevSpot.current ? 'up' : 'down');
      const t = setTimeout(() => setTick(null), 380);
      prevSpot.current = spot;
      return () => clearTimeout(t);
    }
    prevSpot.current = spot;
  }, [spot]);

  // Dismiss popover on outside-click / Escape.
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const tickColor = tick === 'up' ? 'text-up' : tick === 'down' ? 'text-down' : 'text-text-1';

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="chip interactive h-9 px-3 hover:border-[var(--line-strong)]"
      >
        <span className={paused ? 'h-[7px] w-[7px] rounded-full bg-warn' : 'live-dot'} />
        <span className="text-[11px] font-medium uppercase tracking-wider text-text-2">
          {underlying}
        </span>
        <span
          className={`font-mono text-[13px] tabular-nums transition-colors duration-300 ${tickColor}`}
        >
          {spot == null ? '—' : price(spot)}
        </span>
        <span className="hidden h-3 w-px bg-[var(--line)] sm:block" />
        <span className="hidden text-[10px] uppercase tracking-wider text-text-3 sm:inline">fwd</span>
        <span className="hidden font-mono text-[12px] tabular-nums text-text-2 sm:inline">
          {forward == null ? '—' : price(forward)}
        </span>
        <span
          className={`ml-1 hidden text-[10px] font-medium uppercase tracking-wider sm:inline ${
            paused ? 'text-warn' : 'text-accent'
          }`}
        >
          {paused ? 'paused' : 'live'}
        </span>
        <svg
          className={`text-text-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
        >
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      </button>

      {open && (
        <div className="popover-in glass absolute left-1/2 top-[calc(100%+8px)] z-50 w-64 -translate-x-1/2 rounded-[10px] p-3">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="eyebrow">Protocol status</span>
            <span className="font-mono text-[10px] tabular-nums text-text-3">
              {data ? timeUTC(data.onchain_timestamp) : '—'}
            </span>
          </div>
          <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md bg-[var(--line-soft)]">
            <Diag label="Server" value={diagnostics.statusOk ? 'OK' : 'Degraded'} tone={diagnostics.statusOk ? 'good' : 'bad'} />
            <Diag label="Trading" value={paused ? 'Paused' : 'Live'} tone={paused ? 'bad' : 'good'} />
            <Diag label="Ckpt lag" value={`${diagnostics.checkpointLag}`} />
            <Diag label="Time lag" value={`${diagnostics.timeLagS}s`} tone={isFetching ? 'live' : undefined} />
            <Diag label="Quote" value={diagnostics.quoteSymbol} />
            <Diag label="Oracles" value={`${diagnostics.activeOracles}`} />
          </div>
        </div>
      )}
    </div>
  );
}

function Diag({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'good' | 'bad' | 'live';
}) {
  const color =
    tone === 'good' ? 'text-up' : tone === 'bad' ? 'text-down' : 'text-text-1';
  return (
    <div className="flex items-center justify-between bg-[var(--bg-2)] px-2.5 py-2">
      <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
      <span className={`flex items-center gap-1.5 font-mono text-[11px] tabular-nums ${color}`}>
        {tone === 'live' && <span className="live-dot scale-75" />}
        {value}
      </span>
    </div>
  );
}

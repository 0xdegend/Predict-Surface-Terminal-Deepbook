'use client';

/**
 * stage-view.tsx — the Stage, and everything drawn over it.
 *
 * The canvas is ambient. This file is what makes it a screen you can actually run a trade
 * session from: the caption that says what Kelly is doing, the board of markets she rated,
 * and the handful of numbers a trader needs while a run is live.
 *
 * It is deliberately NOT a second dashboard. The dense instrumentation still exists and is
 * one toggle away; putting all of it back on top of the scene would just be the old screen
 * with a fox behind it. What is here is the minimum that keeps the Stage honest: the real
 * ranking, the real money, and the real clock.
 */
import { useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useAutopilotStore } from '@/lib/store/autopilot-store';
import { stageView, type StagePosition } from '@/lib/autopilot/stage-state';
import { scanRowsForStage, type ScanRow } from '@/lib/autopilot/scan';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import type { AutopilotEngineView } from '@/lib/hooks/use-autopilot-engine';

/** The canvas never server-renders and never blocks first paint (CLAUDE.md §7). */
const KellyStage = dynamic(() => import('./kelly-stage').then((m) => m.KellyStage), {
  ssr: false,
  loading: () => <div className="h-full w-full" />,
});

const pct = (p: number) => `${Math.round(p * 100)}%`;
const money = (n: number) => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;

function countdown(ms: number): string {
  if (ms <= 0) return '0:00';
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function StageScreen({ engine, now }: { engine: AutopilotEngineView; now: number }) {
  const status = useAutopilotStore((s) => s.status);
  const scan = useAutopilotStore((s) => s.scan);
  const lastSettlement = useAutopilotStore((s) => s.lastSettlement);
  const lastTradeAt = useAutopilotStore((s) => s.run.lastTradeAt);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');

  const positions = useMemo<StagePosition[]>(
    () => engine.positions.map((p) => ({ marketId: p.marketId, expiry: p.expiry, pnlUsd: p.pnlUsd })),
    [engine.positions],
  );

  const view = useMemo(
    () =>
      stageView({
        status,
        ready: engine.ready,
        candidateCount: engine.candidates.length,
        scan,
        positions,
        lastPlacedAt: lastTradeAt,
        lastSettlement,
        now,
      }),
    [status, engine.ready, engine.candidates.length, scan, positions, lastTradeAt, lastSettlement, now],
  );

  const rows = useMemo(() => scanRowsForStage(scan), [scan]);

  return (
    <div className="card relative overflow-hidden" style={{ height: 'min(62vh, 560px)' }}>
      <div className="absolute inset-0">
        <KellyStage
          candidates={engine.candidates}
          rows={rows}
          positions={positions}
          focusMarketId={view.focusMarketId}
          mood={view.mood}
          beat={view.beat}
          energy={view.energy}
          reduced={reduced}
          now={now}
        />
      </div>

      {/* ── What she is doing, in one line. The only text that always shows. ── */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <p className="max-w-[46ch] text-[13px] font-medium leading-snug text-text-1 drop-shadow-[0_1px_6px_rgba(0,0,0,0.85)]">
            {view.caption}
          </p>
          <StatStrip engine={engine} positions={positions} now={now} />
        </div>
      </div>

      {/* ── The board she rated. Real markets, real scores, this tick. ── */}
      {rows.length > 0 && (
        <div className="pointer-events-none absolute right-3 top-3 w-[188px]">
          <ScanBoard rows={rows} focusMarketId={view.focusMarketId} now={now} />
        </div>
      )}
    </div>
  );
}

function StatStrip({
  engine,
  positions,
  now,
}: {
  engine: AutopilotEngineView;
  positions: StagePosition[];
  now: number;
}) {
  const soonest = positions.reduce<number | null>((a, p) => (a == null || p.expiry < a ? p.expiry : a), null);
  const net = engine.perf.netPnlUsd;
  return (
    <div className="flex items-center gap-4 rounded-md bg-[rgba(10,11,13,0.72)] px-3 py-2 backdrop-blur-sm">
      <Stat label="Spot" value={engine.spot != null ? `$${engine.spot.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'} />
      <Stat
        label="Run PnL"
        value={money(net)}
        tone={net > 0 ? 'up' : net < 0 ? 'down' : undefined}
      />
      {soonest != null && <Stat label="Settles in" value={countdown(soonest - now)} />}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <span
        className={`font-mono text-[12.5px] tabular-nums ${
          tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1'
        }`}
      >
        {value}
      </span>
    </div>
  );
}

/**
 * The markets Kelly rated this tick, best first.
 *
 * This is the receipt for the scene. A trader who wants to know whether the fox is doing
 * anything real can read the same ranking the engine is about to act on, and the dim rows
 * are the ones it judged and passed over, which is most of them most of the time.
 */
function ScanBoard({ rows, focusMarketId, now }: { rows: ScanRow[]; focusMarketId: string | null; now: number }) {
  return (
    <div className="rounded-md bg-[rgba(10,11,13,0.72)] p-2 backdrop-blur-sm">
      <p className="eyebrow mb-1.5 px-1">Rating now</p>
      <ul className="flex flex-col gap-px">
        {rows.map((r) => {
          const focused = r.marketId === focusMarketId;
          return (
            <li
              key={r.marketId}
              className={`flex items-center justify-between gap-2 rounded px-1 py-1 text-[11px] ${
                focused ? 'bg-[rgba(255,255,255,0.08)]' : ''
              }`}
            >
              <span className={`truncate ${r.clears ? 'text-text-2' : 'text-text-3'}`}>
                {r.side === 'range' ? 'Range' : r.side === 'up' ? 'Up' : 'Down'} · {countdown(r.expiry - now)}
              </span>
              <span
                className={`font-mono tabular-nums ${
                  r.clears ? (focused ? 'text-text-1' : 'text-text-2') : 'text-text-3'
                }`}
              >
                {pct(r.prob)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

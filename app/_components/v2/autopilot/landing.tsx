'use client';

/**
 * The Autopilot LANDING: what the page is when nothing is running.
 *
 * Redesigned 2026-09-03 off a reference layout the founder brought. The page used to open
 * on one dense command bar (avatar, title, two pills, the price tape, view tabs, Clear
 * log and Start, all in a strip) and then a setup grid. It now reads top to bottom the
 * way a dashboard does:
 *
 *   1. a page header: the name, one line of purpose, the status, and the one action
 *   2. four stat tiles: the market it trades, and Autopilot's lifetime record
 *   3. the Command Center (how you set a run up) beside The Plan (what it will do)
 *   4. the Performance Overview beside Recent Runs
 *
 * The RUNNING dashboard is untouched and lives in live.tsx; the header here has a
 * compact sticky form for it so Stop is always in reach. Everything below is
 * presentational: the panel still owns the state, the arm flow and the engine.
 */
import Image from 'next/image';
import { useEffect, useId, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { monotonePath } from '@/lib/autopilot/smooth-path';
import type { IconType } from 'react-icons';
import { LuActivity, LuArrowRight, LuGauge, LuHistory, LuMessageSquare, LuSlidersHorizontal, LuTrash2, LuTrendingUp } from 'react-icons/lu';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { MASCOT_SRC } from '@/lib/mascot';
import { num } from '@/lib/format';
import type { AutopilotStatus, RunResult } from '@/lib/store/autopilot-store';
import { PRESET_BY_ID } from '@/lib/autopilot/presets';
import {
  OVERVIEW_RANGES,
  overviewSeries,
  overviewStats,
  startOfDay,
  type OverviewRange,
  type OverviewSeries,
} from '@/lib/autopilot/performance-overview';
import { LivePulse, RunModePill, Sparkline, StatusPill, useTickFlash } from './live';
import { lifetimeStats, pnlClass, signedUsd, type SetupMode } from './shared';

/* ------------------------------- header ---------------------------------- */

export function PageHeader({
  status,
  settling,
  running,
  live,
  view,
  resultCount,
  onToggleView,
  showClear,
  onClear,
  onStart,
  onStop,
  canArm,
}: {
  status: AutopilotStatus;
  settling: boolean;
  /** Armed or paused: the header goes compact and sticky, and the action is Stop. */
  running: boolean;
  live: boolean;
  view: 'cockpit' | 'results';
  resultCount: number;
  onToggleView: () => void;
  showClear: boolean;
  onClear: () => void;
  onStart: () => void;
  onStop: () => void;
  canArm: boolean;
}) {
  const results = view === 'results';
  return (
    <header
      className={
        running
          ? 'glass-card sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2.5 p-3 backdrop-blur-md sm:p-3.5'
          : 'mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between'
      }
    >
      <div className={running ? 'flex min-w-0 flex-1 items-center gap-3' : 'min-w-0'}>
        {running && (
          <div className="relative flex h-9 w-9 flex-none items-center justify-center">
            <span
              aria-hidden
              className="absolute inset-0"
              style={{ background: 'radial-gradient(circle at 50% 42%, var(--accent-soft), transparent 70%)' }}
            />
            <Image src={MASCOT_SRC.thinking} alt="Kelly the fox" width={36} height={36} className="relative h-full w-full object-contain" />
          </div>
        )}
        <h1 className={running ? 'text-[17px] font-semibold tracking-tight text-text-1' : 'text-[26px] font-semibold leading-none tracking-tight text-text-1 sm:text-[28px]'}>
          Autopilot
        </h1>
        <div className={running ? 'flex items-center gap-2' : 'mt-2 flex flex-wrap items-center gap-2.5'}>
          {!running && <p className="text-[12.5px] text-text-2">Kelly trades your plan while you&rsquo;re away.</p>}
          <StatusPill key={`${status}:${settling}`} status={status} settling={settling} />
          {running && <RunModePill live={live} />}
        </div>
      </div>

      <div className={`flex items-center gap-2 ${running ? 'ml-auto flex-none' : 'w-full sm:w-auto sm:flex-none sm:gap-2.5'}`}>
        {showClear && (
          <button
            type="button"
            onClick={onClear}
            className="group glass-inset hidden items-center gap-1.5 rounded-xl px-3 py-2.5 text-[12px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 sm:inline-flex"
          >
            <LuTrash2 size={13} className="transition-colors duration-200 group-hover:text-accent" /> Clear log
          </button>
        )}
        <button
          type="button"
          onClick={onToggleView}
          aria-pressed={results}
          className={`glass-inset interactive inline-flex items-center gap-2 rounded-xl px-3.5 text-[12.5px] font-medium text-text-1 transition-all duration-200 ${
            running ? 'py-2' : 'py-2.5'
          }`}
        >
          {results ? <LuGauge size={15} className="text-text-2" /> : <LuHistory size={15} className="text-text-2" />}
          {results ? 'Dashboard' : 'Results'}
          {!results && resultCount > 0 && (
            <span className="rounded-full bg-white/8 px-1.5 py-px font-mono text-[10.5px] tabular-nums text-text-2">{resultCount}</span>
          )}
        </button>
        <div className={`flex flex-col ${running ? 'w-36' : 'flex-1 sm:w-44 sm:flex-none'}`}>
          {running ? (
            <ReviewButton tone="down" onClick={onStop}>
              Stop Autopilot
            </ReviewButton>
          ) : (
            <ReviewButton tone="up" size="sm" onClick={onStart} disabled={!canArm}>
              Start Autopilot
            </ReviewButton>
          )}
        </div>
      </div>
    </header>
  );
}

/* ------------------------------ stat tiles -------------------------------- */

/** The 1-minute BTC tape the engine already loads (same query key, so one fetch). */
function useBtcTape() {
  return useQuery<{ closes: number[]; times: number[] }>({
    queryKey: ['insights', 'btc', 'candles'],
    queryFn: async () => {
      const r = await fetch('/api/insights/btc/candles');
      if (!r.ok) throw new Error(`candles ${r.status}`);
      return (await r.json()) as { closes: number[]; times: number[] };
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}

/**
 * The BTC price tile. Its second line is the move since local midnight (the tape covers
 * about 33 hours), or since the start of the tape when today's first bar is missing.
 * Labelled as the price, not a portfolio: the reference layout dressed this number as
 * "portfolio value", and it is the market Autopilot trades, so it is called that.
 */
function BtcTile({ spot, watching, now }: { spot: number | null; watching: number; now: number }) {
  const priceRef = useTickFlash(spot);
  const { data: tape } = useBtcTape();
  let change: { usd: number; pct: number; label: string } | null = null;
  if (spot != null && tape && tape.closes.length > 1) {
    const midnight = startOfDay(now);
    const idx = tape.times.findIndex((t) => t >= midnight);
    const base = idx >= 0 ? tape.closes[idx] : tape.closes[0];
    if (base > 0) {
      const usd = spot - base;
      change = {
        usd,
        pct: (usd / base) * 100,
        label: idx >= 0 ? 'today' : `past ${Math.max(1, Math.round(tape.closes.length / 60))}h`,
      };
    }
  }
  return (
    <div className="glass-card flex min-w-0 flex-col gap-2 p-4">
      <span className="eyebrow flex items-center gap-2">
        BTC price <LivePulse />
      </span>
      <div className="flex items-end gap-3">
        <div className="flex min-w-0 items-baseline gap-2">
          <span ref={priceRef} className="font-mono text-[22px] font-semibold leading-none tabular-nums tracking-tight text-text-1">
            {spot != null ? `$${num(spot, 0)}` : '—'}
          </span>
          <span className="text-[11.5px] text-text-3">BTC</span>
        </div>
        <div className="h-9 min-w-0 flex-1">
          <Sparkline value={spot} />
        </div>
      </div>
      <span className={`truncate text-[11.5px] ${change ? pnlClass(change.usd) : 'text-text-3'}`}>
        {change
          ? `${change.usd >= 0 ? '+' : '-'}$${num(Math.abs(change.usd), 0)} (${change.pct >= 0 ? '' : '-'}${Math.abs(change.pct).toFixed(2)}%) ${change.label}`
          : `watching ${watching} market${watching === 1 ? '' : 's'}`}
      </span>
    </div>
  );
}

function Tile({ label, value, sub, valueClass, icon: Icon }: { label: string; value: string; sub: string; valueClass?: string; icon: IconType }) {
  return (
    <div className="glass-card flex min-w-0 flex-col gap-2 p-4">
      <span className="eyebrow flex items-center gap-2">
        <Icon size={12} className="flex-none text-text-3" /> {label}
      </span>
      <span className={`font-mono text-[22px] font-semibold leading-none tabular-nums tracking-tight ${valueClass ?? 'text-text-1'}`}>{value}</span>
      <span className="truncate text-[11.5px] text-text-3">{sub}</span>
    </div>
  );
}

export function StatTiles({ spot, watching, history, now }: { spot: number | null; watching: number; history: RunResult[]; now: number }) {
  const s = lifetimeStats(history);
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <BtcTile spot={spot} watching={watching} now={now} />
      <Tile
        label="All-time P&L"
        value={s.runs > 0 ? signedUsd(s.net) : '$0.00'}
        valueClass={s.runs > 0 ? pnlClass(s.net) : undefined}
        sub={`${s.runs} run${s.runs === 1 ? '' : 's'}  •  ${s.trades} trade${s.trades === 1 ? '' : 's'}`}
        icon={LuTrendingUp}
      />
      <Tile label="Win rate" value={s.winRate != null ? `${s.winRate}%` : '—'} sub={`${s.wins}W / ${s.losses}L`} icon={LuActivity} />
      <Tile label="Runs" value={num(s.runs, 0)} sub={s.runs > 0 ? 'saved to results' : 'none yet'} icon={LuHistory} />
    </div>
  );
}

/* ---------------------------- command center ------------------------------ */

export function CommandCenter({ mode, onMode, children }: { mode: SetupMode; onMode: (m: SetupMode) => void; children: React.ReactNode }) {
  return (
    <section className="glass-card flex min-w-0 flex-col gap-3 p-4">
      <p className="eyebrow">Command center</p>
      <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-white/4 p-1">
        <ModeSegment active={mode === 'auto'} icon={LuMessageSquare} title="Auto" sub="Let Kelly handle it" onClick={() => onMode('auto')} />
        <ModeSegment active={mode === 'manual'} icon={LuSlidersHorizontal} title="Manual" sub="Set up your own rules" onClick={() => onMode('manual')} />
      </div>
      {children}
    </section>
  );
}

function ModeSegment({ active, icon: Icon, title, sub, onClick }: { active: boolean; icon: IconType; title: string; sub: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-left transition-all duration-150 ${
        active ? 'glass-accent text-text-1' : 'text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={15} className={`flex-none ${active ? 'text-accent' : ''}`} />
      <span className="flex flex-col leading-tight">
        <span className="text-[12.5px] font-medium">{title}</span>
        <span className="text-[10px] opacity-70">{sub}</span>
      </span>
    </button>
  );
}

/* -------------------------- performance overview -------------------------- */

export function PerformanceOverview({ history, now }: { history: RunResult[]; now: number }) {
  const [range, setRange] = useState<OverviewRange>('1D');
  const trades = history.flatMap((r) => r.trades);
  const stats = overviewStats(trades, range, now);
  const series = overviewSeries(trades, range, now);
  return (
    <section className="glass-card flex min-w-0 flex-col p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="eyebrow">Performance overview</p>
        <div className="flex gap-0.5 rounded-lg bg-white/4 p-0.5">
          {OVERVIEW_RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              aria-pressed={range === r}
              className={`rounded-md px-3 py-1 text-[11.5px] font-medium transition-all duration-150 ${
                range === r ? 'bg-(--accent-soft) text-accent' : 'text-text-3 hover:text-text-1'
              }`}
            >
              {r}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-5">
        <Kpi label="P&L" value={stats.trades > 0 ? signedUsd(stats.pnlUsd) : '$0.00'} valueClass={stats.trades > 0 ? pnlClass(stats.pnlUsd) : undefined} />
        <Kpi label="Trades" value={num(stats.trades, 0)} />
        <Kpi label="Win rate" value={stats.winRate != null ? `${Math.round(stats.winRate * 100)}%` : '—'} />
        <Kpi label="Best streak" value={stats.bestStreak > 0 ? `${stats.bestStreak}W` : '—'} />
        <Kpi label="Max drawdown" value={stats.maxDrawdown > 0 ? `-$${num(stats.maxDrawdown, 2)}` : '—'} valueClass={stats.maxDrawdown > 0 ? 'text-down' : undefined} />
      </div>

      <OverviewChart series={series} range={range} />
    </section>
  );
}

function Kpi({ label, value, valueClass }: { label: string; value: string; valueClass?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="eyebrow leading-tight">{label}</span>
      <span className={`font-mono text-[15px] leading-none tabular-nums ${valueClass ?? 'text-text-1'}`}>{value}</span>
    </div>
  );
}

/**
 * The cumulative P&L curve.
 *
 * Drawn in real pixels: the plot box is measured (ResizeObserver) and the geometry is
 * computed in that space, so nothing is stretched and the curve's shape is the curve's
 * shape. It used to be a stepped polyline in a 100x100 box scaled to the frame, which
 * read as jagged: hard verticals at every settlement and a flat block of fill.
 *
 * Now: a monotone curve through the settlement points (never overshoots a high or a
 * low, see smooth-path.ts), a fill that fades from the line toward zero, teal above
 * zero and coral below it (the same area path, clipped twice), a soft glow under the
 * stroke, a marker at "now" that breathes, and a draw-in on mount and on range change
 * (the svg is keyed on the range). Axis labels stay HTML, positioned off the same
 * fractions, so they never stretch with the drawing.
 */
function OverviewChart({ series, range }: { series: OverviewSeries; range: OverviewRange }) {
  const boxRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (r) setSize({ w: Math.round(r.width), h: Math.round(r.height) });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // useId's own separators are not safe inside url(#...), so keep the word characters.
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');

  const { w, h } = size;
  const PAD = 6; // keeps the stroke and the marker inside the box at the extremes
  const zeroY = h / 2;
  const px = (x: number) => x * w;
  const py = (v: number) => zeroY - (v / series.yMax) * (zeroY - PAD);
  const pts = series.points.map((p) => ({ x: px(p.x), y: py(p.y) }));
  const line = w > 0 && h > 0 ? monotonePath(pts) : '';
  const first = pts[0];
  const last = pts[pts.length - 1];
  const area = line && last ? `${line} L ${last.x.toFixed(2)},${zeroY} L ${first.x.toFixed(2)},${zeroY} Z` : '';
  const flat = series.points.every((p) => p.y === 0);
  const endTone = last && last.y > zeroY + 0.5 ? 'var(--down)' : 'var(--accent)';
  const up = `url(#${uid}-up)`;
  const down = `url(#${uid}-down)`;
  const above = `url(#${uid}-above)`;
  const below = `url(#${uid}-below)`;

  return (
    <div className="mt-5">
      <div className="relative h-32 pr-12 sm:h-36">
        <div ref={boxRef} className="absolute inset-y-0 left-0 w-[calc(100%-3rem)]">
          {w > 0 && h > 0 && (
            <svg key={range} width={w} height={h} className="overflow-visible" aria-hidden>
              <defs>
                {/* Strongest at the top of the plot and gone at zero, so a small gain sits
                    on a faint wash and a big one on a full one: the fill reads the size. */}
                <linearGradient id={`${uid}-up`} gradientUnits="userSpaceOnUse" x1="0" y1={PAD} x2="0" y2={zeroY}>
                  <stop offset="0" stopColor="var(--accent)" stopOpacity="0.32" />
                  <stop offset="1" stopColor="var(--accent)" stopOpacity="0.02" />
                </linearGradient>
                <linearGradient id={`${uid}-down`} gradientUnits="userSpaceOnUse" x1="0" y1={h - PAD} x2="0" y2={zeroY}>
                  <stop offset="0" stopColor="var(--down)" stopOpacity="0.3" />
                  <stop offset="1" stopColor="var(--down)" stopOpacity="0.02" />
                </linearGradient>
                <clipPath id={`${uid}-above`}>
                  <rect x="0" y="-8" width={w} height={zeroY + 8} />
                </clipPath>
                <clipPath id={`${uid}-below`}>
                  <rect x="0" y={zeroY} width={w} height={h - zeroY + 8} />
                </clipPath>
              </defs>

              {[PAD, zeroY, h - PAD].map((gy) => (
                <line key={gy} x1="0" x2={w} y1={gy} y2={gy} stroke="rgba(255,255,255,0.08)" strokeDasharray="2 4" />
              ))}

              {!flat && (
                <>
                  <path d={area} fill={up} clipPath={above} className="overview-area" />
                  <path d={area} fill={down} clipPath={below} className="overview-area" />
                </>
              )}

              {/* The glow: the same stroke, wide and faint, under the real one. */}
              <path d={line} fill="none" stroke="var(--accent)" strokeWidth="7" opacity="0.14" strokeLinejoin="round" strokeLinecap="round" clipPath={above} pathLength={1} className="overview-line" />
              <path d={line} fill="none" stroke="var(--down)" strokeWidth="7" opacity="0.14" strokeLinejoin="round" strokeLinecap="round" clipPath={below} pathLength={1} className="overview-line" />
              <path d={line} fill="none" stroke="var(--accent)" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" clipPath={above} pathLength={1} className="overview-line" />
              <path d={line} fill="none" stroke="var(--down)" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" clipPath={below} pathLength={1} className="overview-line" />

              {last && (
                <>
                  <circle cx={last.x} cy={last.y} r="3" fill={endTone} className="overview-halo" />
                  <circle cx={last.x} cy={last.y} r="3" fill={endTone} />
                  <circle cx={last.x} cy={last.y} r="1.25" fill="var(--bg-0)" opacity="0.7" />
                </>
              )}
            </svg>
          )}
        </div>
        {series.ticksY.map((t, i) => (
          <span
            key={t.value}
            className="absolute right-0 w-10 text-right font-mono text-[10.5px] tabular-nums text-text-3"
            style={{ top: i === 0 ? 0 : i === 1 ? '50%' : undefined, bottom: i === 2 ? 0 : undefined, transform: i === 1 ? 'translateY(-50%)' : i === 0 ? 'translateY(-50%)' : 'translateY(50%)' }}
          >
            {t.label}
          </span>
        ))}
      </div>
      {/* Same right padding as the plot, so the labels line up under the line; the
          inner box is full width of what is left (padding already took the 3rem). */}
      <div className="relative mt-3 h-4 pr-12">
        <div className="relative h-full w-full">
          {series.ticksX.map((t, i) => (
            <span
              key={`${t.label}-${i}`}
              // Every other label drops out on a phone, where seven of them overlap.
              className={`absolute top-0 font-mono text-[10.5px] tabular-nums text-text-3 ${i % 2 === 1 ? 'hidden sm:inline' : ''}`}
              style={{
                left: `${t.x * 100}%`,
                transform: t.x <= 0 ? 'none' : t.x >= 1 ? 'translateX(-100%)' : 'translateX(-50%)',
              }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------ recent runs ------------------------------- */

function whenWords(ms: number, now: number): string {
  const diff = Math.max(0, now - ms);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = new Date(ms);
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getMonth()]} ${d.getDate()}`;
}

export function RecentRuns({ history, onViewAll, now }: { history: RunResult[]; onViewAll: () => void; now: number }) {
  const recent = history.slice(0, 3);
  return (
    <section className="glass-card flex min-w-0 flex-col p-4">
      <p className="eyebrow">Recent runs</p>
      {recent.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1.5 py-6 text-center">
          <OrbitEmpty />
          <p className="text-[14px] font-medium text-text-1">No runs yet</p>
          <p className="max-w-60 text-[12.5px] leading-relaxed text-text-2">Your Autopilot runs will appear here.</p>
          <button
            type="button"
            onClick={onViewAll}
            className="glass-inset interactive mt-3 rounded-xl px-3.5 py-2 text-[12.5px] font-medium text-text-1 transition-all duration-200"
          >
            View all runs
          </button>
        </div>
      ) : (
        <>
          <ul className="rows-divided mt-3 flex flex-col">
            {recent.map((r) => (
              <li key={r.id} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="flex items-center gap-2 text-[12.5px] text-text-1">
                    {r.preset ? PRESET_BY_ID[r.preset].name : 'Custom'}
                    <span className={`rounded-full px-1.5 py-px text-[9.5px] font-medium uppercase tracking-wider ${r.dryRun ? 'bg-white/6 text-text-2' : 'bg-(--accent-soft) text-accent'}`}>
                      {r.dryRun ? 'Watch' : 'Live'}
                    </span>
                  </p>
                  <p className="mt-0.5 text-[11.5px] text-text-3">
                    {whenWords(r.endedAt, now)} · {r.tradeCount} trade{r.tradeCount === 1 ? '' : 's'} · {r.wins}W / {r.losses}L
                  </p>
                </div>
                <span className={`font-mono text-[13px] tabular-nums ${pnlClass(r.realizedPnlUsd)}`}>{signedUsd(r.realizedPnlUsd)}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={onViewAll}
            className="glass-inset interactive mt-4 inline-flex items-center justify-center gap-2 rounded-xl px-3.5 py-2 text-[12.5px] font-medium text-text-1 transition-all duration-200"
          >
            View all runs <LuArrowRight size={14} className="text-text-3" />
          </button>
        </>
      )}
    </section>
  );
}

/**
 * Kelly in orbit: the Recent runs empty state.
 *
 * The fox sits on a dark disc with a soft accent glow, inside three thin rings that
 * carry a few satellites: the picture of a system waiting for its first run. Drawn as
 * one SVG so the rings are true circles at any size and the accent arcs on the inner
 * ring are dash segments of a normalised path (pathLength=1), not hand-cut geometry.
 * Each ring turns on its own slow period, in alternating directions, so the satellites
 * drift past one another rather than marching; it is an illustration, not chrome, and
 * it stops entirely under reduced motion.
 */
function OrbitEmpty() {
  return (
    <div className="relative mb-2 h-40 w-40 text-accent">
      <svg viewBox="0 0 160 160" width={160} height={160} aria-hidden="true" focusable="false" className="absolute inset-0 h-full w-full">
        <defs>
          <radialGradient id="orbit-glow" cx="50%" cy="48%" r="50%">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.38} />
            <stop offset="55%" stopColor="currentColor" stopOpacity={0.1} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0} />
          </radialGradient>
        </defs>
        {/* Outer ring: the slowest, with two small satellites. */}
        <g className="origin-center motion-safe:animate-[spin_80s_linear_infinite]">
          <circle cx="80" cy="80" r="72" fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="1" />
          <circle cx="135.2" cy="126.3" r="2.2" fill="currentColor" opacity="0.8" />
          <circle cx="55.4" cy="12.3" r="1.4" fill="currentColor" opacity="0.5" />
        </g>
        {/* Middle ring: dotted, turning the other way, one white satellite. */}
        <g className="origin-center motion-safe:animate-[spin_60s_linear_infinite_reverse]">
          <circle cx="80" cy="80" r="58" fill="none" stroke="rgba(255,255,255,0.11)" strokeWidth="1" pathLength={1} strokeDasharray="0.012 0.024" strokeLinecap="round" />
          <circle cx="25.5" cy="60.2" r="2" fill="rgba(255,255,255,0.55)" />
        </g>
        {/* Inner ring: the base hairline, two glowing accent arcs riding on it, and the
            brightest satellite. */}
        <g className="origin-center motion-safe:animate-[spin_40s_linear_infinite]">
          <circle cx="80" cy="80" r="46" fill="none" stroke="rgba(255,255,255,0.09)" strokeWidth="1" />
          <circle cx="80" cy="80" r="46" fill="none" stroke="currentColor" strokeWidth="4" opacity="0.16" pathLength={1} strokeDasharray="0.14 0.36" strokeLinecap="round" />
          <circle cx="80" cy="80" r="46" fill="none" stroke="currentColor" strokeWidth="1.5" opacity="0.75" pathLength={1} strokeDasharray="0.14 0.36" strokeLinecap="round" />
          <circle cx="119.8" cy="57" r="2.6" fill="currentColor" />
        </g>
        {/* The glow and the disc the fox sits on. */}
        <circle cx="80" cy="80" r="54" fill="url(#orbit-glow)" />
        <circle cx="80" cy="80" r="36" fill="var(--bg-1)" stroke="currentColor" strokeOpacity="0.3" strokeWidth="1" />
      </svg>
      <Image src={MASCOT_SRC.thinking} alt="" width={64} height={64} aria-hidden className="absolute inset-0 m-auto h-18 w-18 object-contain" />
    </div>
  );
}

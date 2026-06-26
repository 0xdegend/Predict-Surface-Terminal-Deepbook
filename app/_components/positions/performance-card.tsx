'use client';

/**
 * Performance bento — the trader's settled track record at a glance. Mirrors the
 * account-header bento: a tall win-rate hero (big %, a teal/coral split meter, the
 * W–L record) beside a 2×2 of supporting stats (realized PnL, record, best, streak).
 * Pure presentation; all numbers come pre-derived from `derivePortfolioHistory`.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { IconType } from 'react-icons';
import { LuTarget, LuTrendingUp, LuTrendingDown, LuTrophy, LuFlame, LuSnowflake, LuShare, LuActivity } from 'react-icons/lu';
import { quote as fmtQuote, signed, pct, dateUTC } from '@/lib/format';
import { HUE, IconChip } from '../ui/metric';
import type { WinStats, EquityPoint } from '@/lib/portfolio/history';

/** Spell out wins ("4 wins" / "1 win") — a bare "4W" reads as weeks. Losses keep
 *  the compact "4L" form, which isn't ambiguous. */
function winsLabel(n: number): string {
  return `${n} ${n === 1 ? 'win' : 'wins'}`;
}

export function PerformanceCard({
  stats,
  curve,
  onShare,
}: {
  stats: WinStats;
  curve: EquityPoint[];
  onShare?: () => void;
}) {
  const winPct = stats.winRate * 100;
  const winW = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0;
  const streakWon = stats.streak?.result === 'won';

  return (
    <div className="glass-card grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums lg:grid-cols-3">
      {/* Win-rate hero */}
      <div className="glass-inset relative col-span-2 flex flex-col justify-between gap-5 overflow-hidden p-5 lg:col-span-1 lg:row-span-2">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(120% 90% at 0% 0%, ${
              winPct >= 50 ? 'var(--accent-soft)' : 'var(--down-soft)'
            }, transparent 60%)`,
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <IconChip icon={LuTarget} color={winPct >= 50 ? HUE.teal : HUE.coral} size={30} />
          <span className="eyebrow">Win rate</span>
          {onShare && (
            <button
              onClick={onShare}
              aria-label="Share performance as image"
              className="ctrl-soft ml-auto inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-text-2"
            >
              <LuShare size={12} />
              Share
            </button>
          )}
        </div>

        <div className="relative flex flex-col gap-3">
          <span className="flex items-baseline gap-2">
            <span
              className={`text-[40px] leading-none tracking-tight ${
                winPct >= 50 ? 'text-up' : 'text-down'
              }`}
            >
              {pct(stats.winRate, 1)}
            </span>
            <span className="text-[11px] text-text-3">
              {stats.total} settled
            </span>
          </span>

          {/* teal/coral split meter */}
          <div className="flex h-2 overflow-hidden rounded-full bg-bg-3">
            <span className="h-full bg-up/80" style={{ width: `${winW}%` }} />
            <span className="h-full flex-1 bg-down/70" />
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1.5 text-up">
              <span className="h-1.5 w-1.5 rounded-full bg-up" />
              {winsLabel(stats.wins)}
            </span>
            <span className="flex items-center gap-1.5 text-down">
              {stats.losses}L
              <span className="h-1.5 w-1.5 rounded-full bg-down" />
            </span>
          </div>

          {stats.unclaimed > 0 && (
            <span className="text-[10px] text-text-3">
              +{stats.unclaimed} settled awaiting claim
            </span>
          )}
        </div>
      </div>

      <Tile
        icon={stats.realizedPnl >= 0 ? LuTrendingUp : LuTrendingDown}
        color={stats.realizedPnl >= 0 ? HUE.teal : HUE.coral}
        label="Realized PnL"
        value={signed(stats.realizedPnl)}
        tone={stats.realizedPnl >= 0 ? 'up' : 'down'}
        sub={`on ${fmtQuote(stats.staked)} staked`}
      />
      <Tile
        icon={LuTrophy}
        color={HUE.amber}
        label="Best result"
        value={signed(stats.best)}
        tone={stats.best >= 0 ? 'up' : undefined}
        sub="single trade"
      />
      <Tile
        icon={LuTrendingUp}
        color={HUE.blue}
        label="Avg ROI"
        value={stats.staked > 0 ? pct(stats.realizedPnl / stats.staked, 1) : '—'}
        tone={stats.realizedPnl >= 0 ? 'up' : 'down'}
        sub="per trade staked"
      />
      <Tile
        icon={streakWon ? LuFlame : LuSnowflake}
        color={streakWon ? HUE.coral : HUE.blue}
        label="Current streak"
        value={stats.streak ? (streakWon ? winsLabel(stats.streak.count) : `${stats.streak.count}L`) : '—'}
        tone={stats.streak ? (streakWon ? 'up' : 'down') : undefined}
        sub={streakWon ? 'on a heater' : stats.streak ? 'cold run' : 'no trades yet'}
      />

      {/* Cumulative-PnL curve — spans the full width beneath the bento. Hover to
          read how the record was built, trade by trade; filter by time range. */}
      {curve.length > 0 && (
        <div className="glass-inset col-span-2 flex flex-col gap-3 p-4 lg:col-span-3">
          <EquityChart points={curve} />
        </div>
      )}
    </div>
  );
}

type RangeKey = '1D' | '1W' | '1M' | 'All';
const RANGES: { key: RangeKey; ms: number }[] = [
  { key: '1D', ms: 24 * 3_600_000 },
  { key: '1W', ms: 7 * 24 * 3_600_000 },
  { key: '1M', ms: 30 * 24 * 3_600_000 },
  { key: 'All', ms: Infinity },
];

/**
 * Interactive cumulative-PnL ("equity") curve with a smoothed line and time-range
 * filters. SVG is drawn in measured pixel space (a ResizeObserver tracks the
 * container width) so the hover crosshair maps exactly to the cursor. A windowed
 * range leads with an anchor = the running total entering the window, so the line
 * continues from where you stood rather than snapping to zero.
 */
function EquityChart({ points }: { points: EquityPoint[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [hi, setHi] = useState<number | null>(null);
  const [range, setRange] = useState<RangeKey>('All');
  // Lazy initializer runs once (the React-sanctioned way to read the clock in a
  // component) — the windows anchor to mount time, which is fine for this chart.
  const [now] = useState(() => Date.now());

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(entries[0].contentRect.width));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // How many trades fall inside each range — empty ranges are disabled.
  const counts = useMemo(() => {
    const m = {} as Record<RangeKey, number>;
    for (const r of RANGES) {
      m[r.key] = r.ms === Infinity ? points.length : points.filter((p) => p.t >= now - r.ms).length;
    }
    return m;
  }, [points, now]);

  // Fall back to All if the selected range emptied out.
  const effRange = counts[range] > 0 ? range : 'All';
  const rangeMs = RANGES.find((r) => r.key === effRange)!.ms;

  // Windowed series, REBASED to the equity entering the window: the curve starts
  // at 0 and shows the PnL earned *within* the selected period, so the headline
  // matches what the 1D/1W/1M filter implies (not the all-time running total,
  // which read as "you lost this much today" when it carried prior-period losses).
  // 'All' has `anchor = 0`, so it stays the true all-time cumulative untouched.
  const { series, windowed, firstT, lastT } = useMemo(() => {
    const cutoff = rangeMs === Infinity ? -Infinity : now - rangeMs;
    const windowed = points.filter((p) => p.t >= cutoff);
    const before = points.filter((p) => p.t < cutoff);
    const anchor = before.length ? before[before.length - 1].cumulative : 0;
    return {
      windowed,
      series: [0, ...windowed.map((p) => p.cumulative - anchor)],
      firstT: windowed[0]?.t ?? now,
      lastT: windowed[windowed.length - 1]?.t ?? now,
    };
  }, [points, rangeMs, now]);

  const H = 172;
  const padX = 10;
  const padTop = 12;
  const padBottom = 16;
  const n = series.length;
  const min = Math.min(0, ...series);
  const max = Math.max(0, ...series);
  const span = max - min || 1;

  const x = (i: number) => padX + (n > 1 ? (i / (n - 1)) * (w - 2 * padX) : 0);
  const y = (v: number) => padTop + (1 - (v - min) / span) * (H - padTop - padBottom);

  const latest = series[n - 1];
  const positive = latest >= 0;
  const stroke = positive ? 'var(--up)' : 'var(--down)';

  const pts = series.map((v, i) => ({ x: x(i), y: y(v) }));
  const linePath = smoothLinePath(pts);
  const areaPath =
    n > 1 ? `${linePath} L${x(n - 1).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z` : '';

  function pick(clientX: number) {
    if (!wrapRef.current || n < 2 || w === 0) return;
    const rect = wrapRef.current.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (clientX - rect.left - padX) / (w - 2 * padX)));
    setHi(Math.round(t * (n - 1)));
  }

  const hoverPoint = hi != null && hi >= 1 ? windowed[hi - 1] : null;

  return (
    <div className="flex flex-col gap-3">
      {/* header — label + current total on the left, range filter on the right */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-col gap-1.5">
          <div className="flex items-center gap-2">
            <IconChip icon={LuActivity} color={positive ? HUE.teal : HUE.coral} size={22} />
            <span className="eyebrow">
              {effRange === 'All' ? 'Cumulative PnL' : `PnL · ${effRange}`}
            </span>
          </div>
          <span className={`font-mono text-[22px] leading-none tracking-tight tabular-nums ${positive ? 'text-up' : 'text-down'}`}>
            {signed(latest)}
            <span className="ml-1.5 text-[11px] text-text-3">DUSDC</span>
          </span>
          <span className="font-mono text-[10px] text-text-3">
            {dateUTC(firstT, false)} → {dateUTC(lastT, false)} · {windowed.length} settled
          </span>
        </div>
        <div className="flex items-center gap-0.5 rounded-lg bg-bg-3 p-0.5">
          {RANGES.map((r) => {
            const enabled = counts[r.key] > 0;
            const isActive = effRange === r.key;
            return (
              <button
                key={r.key}
                type="button"
                onClick={() => enabled && setRange(r.key)}
                disabled={!enabled}
                aria-pressed={isActive}
                className={`rounded-md px-2 py-1 text-[10px] font-semibold uppercase tracking-wider transition-colors ${
                  isActive
                    ? 'bg-white/10 text-text-1'
                    : enabled
                      ? 'text-text-3 hover:text-text-2'
                      : 'cursor-not-allowed text-text-3/35'
                }`}
              >
                {r.key}
              </button>
            );
          })}
        </div>
      </div>

      <div
        ref={wrapRef}
        className="relative w-full cursor-crosshair touch-none"
        style={{ height: H }}
        onMouseMove={(e) => pick(e.clientX)}
        onMouseLeave={() => setHi(null)}
        onTouchStart={(e) => pick(e.touches[0].clientX)}
        onTouchMove={(e) => pick(e.touches[0].clientX)}
        onTouchEnd={() => setHi(null)}
      >
        {w > 0 && (
          <svg width={w} height={H} className="block">
            <defs>
              <linearGradient id="eq-fill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={stroke} stopOpacity="0.26" />
                <stop offset="100%" stopColor={stroke} stopOpacity="0" />
              </linearGradient>
            </defs>
            {/* zero reference */}
            <line
              x1={padX}
              x2={w - padX}
              y1={y(0)}
              y2={y(0)}
              stroke="rgba(255,255,255,0.12)"
              strokeDasharray="4 4"
            />
            {n > 1 && <path d={areaPath} fill="url(#eq-fill)" />}
            {n > 1 && (
              <path
                d={linePath}
                fill="none"
                stroke={stroke}
                strokeWidth={2}
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            )}
            {n > 1 && <circle cx={x(n - 1)} cy={y(latest)} r={3.5} fill={stroke} />}
            {hi != null && (
              <>
                <line x1={x(hi)} x2={x(hi)} y1={padTop} y2={H - padBottom} stroke="rgba(255,255,255,0.2)" />
                <circle cx={x(hi)} cy={y(series[hi])} r={4} fill={stroke} stroke="var(--bg-1)" strokeWidth={1.5} />
              </>
            )}
          </svg>
        )}

        {hi != null && (
          <EquityTooltip
            left={x(hi)}
            chartWidth={w}
            cumulative={series[hi]}
            point={hoverPoint}
            total={points.length}
          />
        )}
      </div>
    </div>
  );
}

/**
 * Catmull-Rom → cubic-bézier smoothing: a clean curvy line that still passes
 * through every data point (so the hover dot sits exactly on the curve).
 */
function smoothLinePath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return '';
  if (pts.length === 1) return `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  let d = `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x.toFixed(2)} ${c1y.toFixed(2)} ${c2x.toFixed(2)} ${c2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return d;
}

/** Floating readout for the hovered point, clamped within the chart width. */
function EquityTooltip({
  left,
  chartWidth,
  cumulative,
  point,
  total,
}: {
  left: number;
  chartWidth: number;
  cumulative: number;
  point: EquityPoint | null;
  total: number;
}) {
  const tw = 156;
  const clamped = Math.max(2, Math.min(left - tw / 2, chartWidth - tw - 2));
  return (
    <div
      className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line bg-bg-1/95 px-2.5 py-2 font-mono text-[10px] shadow-[0_12px_30px_-12px_rgba(0,0,0,0.8)] backdrop-blur"
      style={{ left: clamped, width: tw }}
    >
      <div className="flex items-center justify-between text-text-3">
        <span>{point ? `Trade ${point.index} / ${total}` : 'Start'}</span>
        {point && <span>{dateUTC(point.t, false)}</span>}
      </div>
      <div className="mt-1.5 flex items-baseline justify-between">
        <span className="text-text-2">Cumulative</span>
        <span className={`tabular-nums ${cumulative >= 0 ? 'text-up' : 'text-down'}`}>
          {signed(cumulative)}
        </span>
      </div>
      {point && (
        <div className="mt-0.5 flex items-baseline justify-between">
          <span className="text-text-2">This trade</span>
          <span className={`tabular-nums ${point.pnl >= 0 ? 'text-up' : 'text-down'}`}>
            {signed(point.pnl)}
          </span>
        </div>
      )}
    </div>
  );
}

function Tile({
  icon,
  color,
  label,
  value,
  tone,
  sub,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  tone?: 'up' | 'down';
  sub?: string;
}) {
  const valueColor = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1';
  return (
    <div className="glass-inset flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className={`text-[20px] leading-none tracking-tight ${valueColor}`}>{value}</span>
      {sub && <span className="text-[10px] text-text-3">{sub}</span>}
    </div>
  );
}

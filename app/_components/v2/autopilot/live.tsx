'use client';

/**
 * The RUNNING Autopilot dashboard: the live stat band, the run meters, live
 * performance, the run log, and the status banners.
 *
 * Split out of autopilot-panel.tsx.
 */
import { useEffect, useRef } from 'react';
import type { IconType } from 'react-icons';
import { LuActivity, LuCircleCheck, LuClock, LuExternalLink, LuEye, LuGauge, LuHand, LuHistory, LuLayers, LuRadioTower, LuShieldCheck, LuTimer, LuTrendingUp, LuTriangleAlert, LuWallet, LuZap } from 'react-icons/lu';
import { num } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import type { AutopilotOpenView, AutopilotPerf } from '@/lib/hooks/use-autopilot-engine';
import type { AutopilotLogEntry, RunResult } from '@/lib/store/autopilot-store';
import { type StopReason, stopReasonKind, stopReasonLabel } from '@/lib/autopilot/policy';
import { pnlClass, signedUsd } from './shared';
import { clamp } from './setup';

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

function mmss(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * RunningModeBanner — which mode the armed run is in.
 *
 * This used to be a card on the setup screen with the watch/live toggle, the funding
 * choice and a paragraph about session keys. All three were decisions about pressing
 * Start being asked before you had picked a style, so they moved into the arm confirm.
 * What is left is the one thing that belongs on a RUNNING dashboard: a read-out of the
 * mode you are actually in, with no controls on it.
 */
export function RunningModeBanner({ live }: { live: boolean }) {
  return (
    <div className={`glass-card flex items-start gap-2.5 p-4 ${live ? 'border-up/30' : ''}`}>
      {live ? (
        <LuRadioTower size={15} className="mt-px flex-none text-up" />
      ) : (
        <LuEye size={15} className="mt-px flex-none text-accent" />
      )}
      {/* One line. The long version restated the plan card's own mode note directly
          above it, which cost about forty words at the top of a RUNNING dashboard,
          pushing the live meters off a phone screen. The plan card no longer repeats
          the mode, so this is now the single statement of it. */}
      <p className="text-[12px] leading-relaxed text-text-2">
        <span className="font-medium text-text-1">{live ? 'Live trading.' : 'Watch mode.'}</span>{' '}
        {live ? 'Real DUSDC, inside your budget and limits.' : 'Nothing is spent.'}
      </p>
    </div>
  );
}

export function PerformancePanel({ perf, positions }: { perf: AutopilotPerf; positions: AutopilotOpenView[] }) {
  const resolved = perf.wins + perf.losses;
  return (
    <div className="flex flex-col gap-3">
      {/* Summary */}
      <div className="glass-card p-4">
        <div className="flex items-end justify-between gap-3">
          <div className="flex flex-col gap-1">
            <span className="eyebrow flex items-center gap-1.5">
              <LuActivity size={12} className="text-accent" /> Live performance
            </span>
            <span className={`font-mono text-[26px] font-semibold leading-none tabular-nums ${pnlClass(perf.netPnlUsd)}`}>
              {signedUsd(perf.netPnlUsd)}
            </span>
            <span className="text-[11px] text-text-3">net profit and loss this run</span>
          </div>
          <div className="flex flex-col items-end gap-1 text-[11.5px]">
            <PerfStat label="Open" value={signedUsd(perf.unrealizedPnlUsd)} tone={perf.unrealizedPnlUsd} />
            <PerfStat label="Settled" value={signedUsd(perf.realizedPnlUsd)} tone={perf.realizedPnlUsd} />
            <span className="font-mono tabular-nums text-text-2">
              {perf.wins}W / {perf.losses}L{resolved > 0 && perf.winRate != null ? ` · ${Math.round(perf.winRate * 100)}%` : ''}
            </span>
          </div>
        </div>
        {perf.openCount > 0 && (
          <div className="mt-3 flex items-center gap-5 border-t border-white/6 pt-3 text-[11px] text-text-3">
            <span>
              At risk <span className="font-mono tabular-nums text-text-1">${num(perf.atRiskUsd, 2)}</span>
            </span>
            <span>
              Now worth <span className="font-mono tabular-nums text-text-1">${num(perf.markValueUsd, 2)}</span>
            </span>
          </div>
        )}
      </div>

      {/* Open trades, marked live */}
      {positions.length > 0 && (
        <div className="glass-card overflow-hidden">
          <div className="flex items-center gap-2 border-b border-white/6 px-4 py-2.5">
            <h3 className="text-[12.5px] font-semibold text-text-1">Open trades</h3>
            <span className="font-mono text-[11px] tabular-nums text-text-3">{positions.length}</span>
            <span className="ml-auto text-[10px] text-text-3">live PnL, updates with the price</span>
          </div>
          <div className="rows-divided max-h-72 overflow-y-auto">
            {positions.map((p) => (
              <OpenTradeRow key={p.marketId} p={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function PerfStat({ label, value, tone }: { label: string; value: string; tone: number }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-text-3">{label}</span>
      <span className={`font-mono tabular-nums ${pnlClass(tone)}`}>{value}</span>
    </span>
  );
}

function OpenTradeRow({ p }: { p: AutopilotOpenView }) {
  const dir = p.side === 'range' ? 'RANGE' : p.side.toUpperCase();
  const dirCls = p.side === 'up' ? 'text-up' : p.side === 'down' ? 'text-down' : 'text-text-1';
  const label =
    p.side === 'range' ? `$${num(p.lower ?? 0, 0)}–$${num(p.higher ?? 0, 0)}` : `$${num(p.strike ?? 0, 0)}`;
  const delta = Math.round(p.deltaPp);
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <span className={`w-12 flex-none font-mono text-[11px] font-semibold ${dirCls}`}>{dir}</span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-[12.5px] tabular-nums text-text-1">{label}</span>
          {p.dryRun && (
            <span className="rounded bg-white/5 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-text-3">
              sim
            </span>
          )}
        </div>
        <div className="font-mono text-[10.5px] tabular-nums text-text-3">
          ${num(p.stake, 0)} · {Math.round(p.entryProb * 100)}% → {Math.round(p.currentProb * 100)}% (
          {delta >= 0 ? '+' : ''}
          {delta})
        </div>
      </div>
      <span className={`flex-none font-mono text-[12.5px] tabular-nums ${pnlClass(p.pnlUsd)}`}>{signedUsd(p.pnlUsd)}</span>
    </div>
  );
}

export function StatusPill({ status, settling }: { status: 'idle' | 'armed' | 'stopped'; settling?: boolean }) {
  // While stopped with trades still resolving, "Finishing" reads truer than "Stopped".
  const map =
    status === 'stopped' && settling
      ? { label: 'Finishing', cls: 'bg-white/8 text-text-2' }
      : {
          idle: { label: 'Idle', cls: 'bg-white/5 text-text-3' },
          armed: { label: 'Running', cls: 'bg-(--accent-soft) text-up' },
          stopped: { label: 'Stopped', cls: 'bg-(--down-soft) text-down' },
        }[status];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${map.cls}`}>{map.label}</span>;
}

/**
 * Shown after a reload landed an armed run as stopped (for safety). Reassures that
 * the run + its open trades are still here and settling, and that Autopilot only
 * paused PLACING new trades — one tap re-arms.
 */
/**
 * "Clearing this log in 8s", shown under the stop banner once a finished run is on its
 * way out. It appears only after a quiet pause, so the countdown is never the first thing
 * on screen when a run ends, and it says the number out loud rather than letting the
 * dashboard vanish unannounced. The header's "Clear log" button makes it happen now.
 */
export function ClearingNote({ seconds }: { seconds: number | null }) {
  if (seconds == null) return null;
  return (
    <span className="mt-1 text-[11px] leading-relaxed opacity-70">
      Clearing this log in {seconds}s.
    </span>
  );
}

export function ReloadBanner({ settlingCount }: { settlingCount: number }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-(--accent-line) bg-(--accent-soft) p-3.5 text-[12.5px] text-text-1">
      <LuClock size={15} className="mt-px flex-none text-accent" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">Picked up where you left off.</span>
        <span className="text-[11.5px] leading-relaxed text-text-2">
          {settlingCount > 0
            ? `Your ${settlingCount} open trade${settlingCount === 1 ? ' is' : 's are'} still here and settling. `
            : ''}
          Autopilot paused placing new trades when the page reloaded, so nothing traded on its own. Start it again to keep
          it going.
        </span>
      </div>
    </div>
  );
}

/**
 * The stop banner. A run that ran its course (budget / trade cap / time) reads as a
 * calm finish, not an alarm; only a real problem (key/gas/feed, or the losing-streak
 * guard) gets the warning tone. Either way, if trades are still open it reassures
 * that Autopilot has only stopped opening NEW trades and the rest settle on their own.
 */
/**
 * The "some trades are still running" line, built in JS rather than assembled out of
 * inline ternaries in JSX.
 *
 * Two bugs came out of the JSX version at once. It rendered "1 tradestill open", because
 * a JSX text node that both begins with a space and spans a line break loses that leading
 * space, and the singular ternary next to it collapsed to an empty string with nothing to
 * separate the words. It also read "it finishes on its own and land in your results",
 * since only some of the verbs were switched for the singular. Neither is possible here.
 */
function settlingLine(n: number): string {
  return n === 1
    ? 'One trade is still open. Autopilot won\u2019t place any new ones, and it settles on its own and lands in your results.'
    : `${n} trades are still open. Autopilot won\u2019t place any new ones, and they settle on their own and land in your results.`;
}

export function StoppedBanner({
  reason,
  settlingCount,
  clearInSec,
}: {
  reason: StopReason | null;
  settlingCount: number;
  clearInSec?: number | null;
}) {
  const attention = reason != null && stopReasonKind(reason) === 'attention';
  const headline =
    reason == null
      ? 'You stopped Autopilot.'
      : attention
        ? `Autopilot stopped. ${stopReasonLabel(reason)}.`
        : `Autopilot finished. ${stopReasonLabel(reason)}.`;
  const Icon = attention ? LuTriangleAlert : settlingCount > 0 ? LuClock : LuCircleCheck;
  const toneCls = attention
    ? 'border-down/40 bg-down/10 text-down'
    : 'border-(--accent-line) bg-(--accent-soft) text-text-1';
  return (
    <div className={`mb-4 flex items-start gap-2.5 rounded-lg border p-3.5 text-[12.5px] ${toneCls}`}>
      <Icon size={15} className="mt-px flex-none" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">{headline}</span>
        {settlingCount > 0 && <span className="text-[11.5px] leading-relaxed opacity-90">{settlingLine(settlingCount)}</span>}
        <ClearingNote seconds={clearInSec ?? null} />
      </div>
    </div>
  );
}

function Meter({
  icon: Icon,
  label,
  value,
  sub,
  frac,
  color,
}: {
  icon: IconType;
  label: string;
  value: React.ReactNode;
  sub: string;
  frac: number;
  color: string;
}) {
  const pct = clamp(frac, 0, 1) * 100;
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-2 p-3">
      <div className="flex items-center gap-1.5">
        <Icon size={12} style={{ color }} className="flex-none" />
        <span className="eyebrow truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-[18px] leading-none tabular-nums tracking-tight text-text-1">{value}</span>
        <span className="font-mono text-[10.5px] tabular-nums text-text-3">{sub}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/6">
        <div className="h-full rounded-full transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

/** A small teal "this is live" pulse dot. */
function LivePulse() {
  return (
    <span className="relative flex h-1.5 w-1.5">
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-75" />
      <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" />
    </span>
  );
}

const SPARK_UP = '#3ecf9a';

const SPARK_DOWN = '#f0796b';

/**
 * A tiny live price sparkline on a canvas. It keeps its own rolling buffer of the last
 * ~55 values (fed the live spot each render) and redraws on change. Canvas (not state)
 * keeps it off the React render path: no per-tick re-render, and no ref reads during
 * render. Trend colours the line teal (up over the window) or coral (down).
 */
function Sparkline({ value }: { value: number | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const bufRef = useRef<number[]>([]);

  useEffect(() => {
    if (value != null && Number.isFinite(value)) {
      const buf = bufRef.current;
      if (buf.length === 0 || buf[buf.length - 1] !== value) {
        buf.push(value);
        if (buf.length > 55) buf.shift();
      }
    }
    const cv = canvasRef.current;
    if (!cv) return;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (w === 0 || h === 0) return;
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    const nw = Math.round(w * dpr);
    const nh = Math.round(h * dpr);
    if (cv.width !== nw || cv.height !== nh) {
      cv.width = nw;
      cv.height = nh;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const b = bufRef.current;
    if (b.length < 2) return;
    const min = Math.min(...b);
    const max = Math.max(...b);
    const range = max - min || 1;
    const px = (i: number) => (i / (b.length - 1)) * w;
    const py = (v: number) => h - 2 - ((v - min) / range) * (h - 4);
    const stroke = b[b.length - 1] >= b[0] ? SPARK_UP : SPARK_DOWN;

    ctx.beginPath();
    ctx.moveTo(px(0), py(b[0]));
    for (let i = 1; i < b.length; i++) ctx.lineTo(px(i), py(b[i]));
    ctx.lineTo(px(b.length - 1), h);
    ctx.lineTo(px(0), h);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, `${stroke}2e`);
    grad.addColorStop(1, `${stroke}00`);
    ctx.fillStyle = grad;
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(px(0), py(b[0]));
    for (let i = 1; i < b.length; i++) ctx.lineTo(px(i), py(b[i]));
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(px(b.length - 1), py(b[b.length - 1]), 2, 0, Math.PI * 2);
    ctx.fillStyle = stroke;
    ctx.fill();
  }, [value]);

  return <canvas ref={canvasRef} className="h-full w-full" aria-hidden />;
}

/** A generic KPI tile: label (+ optional live pulse), a big number, a small sub. */
function StatTile({
  label,
  value,
  sub,
  valueClass,
  icon: Icon,
  live,
}: {
  label: string;
  value: React.ReactNode;
  sub?: string;
  valueClass?: string;
  icon?: IconType;
  live?: boolean;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-1 p-3">
      <span className="eyebrow flex items-center gap-1.5">
        {Icon && <Icon size={11} className="flex-none text-text-3" />}
        <span className="truncate">{label}</span>
        {live && <LivePulse />}
      </span>
      <span className={`font-mono text-[19px] font-semibold leading-none tabular-nums tracking-tight ${valueClass ?? 'text-text-1'}`}>
        {value}
      </span>
      {sub && <span className="truncate font-mono text-[10.5px] tabular-nums text-text-3">{sub}</span>}
    </div>
  );
}

/** The live-market tile: BTC spot with a pulse + an inline sparkline that moves. */
function LivePriceTile({ spot, watching }: { spot: number | null; watching: number }) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-1 p-3">
      <span className="eyebrow flex items-center gap-1.5">
        BTC <LivePulse />
      </span>
      <div className="flex items-end gap-2">
        <span className="font-mono text-[19px] font-semibold leading-none tabular-nums tracking-tight text-text-1">
          {spot != null ? `$${num(spot, 0)}` : '—'}
        </span>
        <div className="h-6 min-w-0 flex-1">
          <Sparkline value={spot} />
        </div>
      </div>
      <span className="truncate font-mono text-[10.5px] tabular-nums text-text-3">
        watching {watching} market{watching === 1 ? '' : 's'}
      </span>
    </div>
  );
}

/**
 * The top-of-dashboard stat band: one live-market tile plus Autopilot's lifetime
 * numbers (from saved results).
 *
 * Before the first run those three lifetime tiles read "+$0.00 / — / 0": three tiles of
 * nothing, on the one screen a first-time trader is trying to make sense of. They are
 * also already carried by the Results tab's all-time summary, so holding them back until
 * there IS a track record costs nothing and buys back the top of the page.
 */
export function StatBand({ spot, watching, history }: { spot: number | null; watching: number; history: RunResult[] }) {
  // All four tiles, always. This used to collapse to the price tile alone until a run
  // had been saved, which hid the win rate and the P&L from exactly the person deciding
  // whether to try this: someone with no runs yet. The tiles were already written for
  // the empty case ("$0.00", "none yet", a dash for an undefined rate), so the early
  // return was doing nothing but taking the row away.
  const net = history.reduce((a, r) => a + r.realizedPnlUsd, 0);
  const wins = history.reduce((a, r) => a + r.wins, 0);
  const losses = history.reduce((a, r) => a + r.losses, 0);
  const runs = history.length;
  const trades = history.reduce((a, r) => a + r.tradeCount, 0);
  const resolved = wins + losses;
  const winRate = resolved > 0 ? Math.round((wins / resolved) * 100) : null;
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <LivePriceTile spot={spot} watching={watching} />
      <StatTile
        label="All-time P&L"
        value={runs > 0 ? signedUsd(net) : '$0.00'}
        valueClass={runs > 0 ? pnlClass(net) : 'text-text-2'}
        sub={`${runs} run${runs === 1 ? '' : 's'} · ${trades} trade${trades === 1 ? '' : 's'}`}
        icon={LuTrendingUp}
      />
      <StatTile
        label="Win rate"
        value={winRate != null ? `${winRate}%` : '—'}
        sub={`${wins}W / ${losses}L`}
        icon={LuActivity}
      />
      <StatTile label="Runs" value={num(runs, 0)} sub={runs > 0 ? 'saved to results' : 'none yet'} icon={LuHistory} />
    </div>
  );
}

/** The four live meters (budget / trades / open / time), a full-width strip. */
export function MetersStrip({
  spentUsd,
  budgetUsd,
  tradeCount,
  maxTrades,
  openCount,
  maxConcurrent,
  armed,
  timeLeftMs,
  armDurationMs,
}: {
  spentUsd: number;
  budgetUsd: number;
  tradeCount: number;
  maxTrades: number;
  openCount: number;
  maxConcurrent: number;
  armed: boolean;
  timeLeftMs: number;
  armDurationMs: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Meter
        icon={LuWallet}
        label="Budget"
        value={`$${num(spentUsd, 0)}`}
        sub={`of $${num(budgetUsd, 0)}`}
        frac={budgetUsd > 0 ? spentUsd / budgetUsd : 0}
        color="var(--up)"
      />
      <Meter
        icon={LuActivity}
        label="Trades"
        value={num(tradeCount, 0)}
        sub={`of ${num(maxTrades, 0)}`}
        frac={maxTrades > 0 ? tradeCount / maxTrades : 0}
        color="#6aa6e6"
      />
      <Meter
        icon={LuLayers}
        label="Open now"
        value={num(openCount, 0)}
        sub={`of ${num(maxConcurrent, 0)}`}
        frac={maxConcurrent > 0 ? openCount / maxConcurrent : 0}
        color="#c9a0ff"
      />
      <Meter
        icon={LuTimer}
        label={armed ? 'Time left' : 'Ran for'}
        value={mmss(timeLeftMs)}
        sub={armed ? 'remaining' : 'of the run'}
        frac={armed && armDurationMs > 0 ? 1 - timeLeftMs / armDurationMs : 0}
        color="#9aa4af"
      />
    </div>
  );
}

/** The run log as a self-contained panel (its own header), so it can sit in a grid cell. */
export function RunLogPanel({
  log,
  now,
  armed,
  ready,
}: {
  log: AutopilotLogEntry[];
  now: number;
  armed: boolean;
  ready: boolean;
}) {
  return (
    <div className="glass-card flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 border-b border-white/6 px-4 py-2.5">
        <h2 className="text-[13px] font-semibold text-text-1">Run log</h2>
        {armed && (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-(--accent-soft) px-2 py-0.5 text-[10.5px] font-medium text-up">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" />
            </span>
            Live
          </span>
        )}
        {!ready && <span className="ml-auto text-[10.5px] text-text-3">Waiting for the live feed…</span>}
      </div>
      {log.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 py-10 text-center">
          <LuGauge size={22} className="text-text-3" />
          <p className="text-[13px] text-text-1">Nothing yet.</p>
          <p className="max-w-xs text-[12px] leading-relaxed text-text-2">
            Kelly logs every trade she places here as it happens.
          </p>
        </div>
      ) : (
        <div className="rows-divided max-h-112 overflow-y-auto">
          {log.map((e) => (
            <LogRow key={e.id} entry={e} now={now} />
          ))}
        </div>
      )}
    </div>
  );
}

function LogRow({ entry, now }: { entry: AutopilotLogEntry; now: number }) {
  const meta: Record<AutopilotLogEntry['kind'], { Icon: IconType; cls: string }> = {
    armed: { Icon: LuZap, cls: 'text-accent' },
    placed: { Icon: LuCircleCheck, cls: 'text-up' },
    held: { Icon: LuHand, cls: 'text-text-3' },
    settled: { Icon: LuActivity, cls: 'text-text-2' },
    disarmed: { Icon: LuShieldCheck, cls: 'text-text-2' },
  };
  const { Icon, cls } = meta[entry.kind];
  return (
    <div className="flex items-center gap-2.5 px-4 py-2.5">
      <Icon size={14} className={`flex-none ${cls}`} />
      <p className="min-w-0 flex-1 truncate text-[12.5px] text-text-1">
        {entry.text}
        {entry.dryRun && (
          <span className="ml-1.5 rounded bg-white/5 px-1 py-px align-middle text-[9.5px] font-medium uppercase tracking-wide text-text-3">
            sim
          </span>
        )}
      </p>
      {entry.digest && (
        <a
          href={`https://suiscan.xyz/${predictV2Config.network}/tx/${entry.digest}`}
          target="_blank"
          rel="noreferrer"
          title="View on the explorer"
          className="flex-none text-text-3 transition-colors hover:text-accent"
        >
          <LuExternalLink size={12} />
        </a>
      )}
      <span className="flex-none font-mono text-[10.5px] tabular-nums text-text-3">{ago(entry.at, now)}</span>
    </div>
  );
}

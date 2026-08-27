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
import type { RunTape as RunTapeData, TapeTrade } from '@/lib/autopilot/run-tape';
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
/**
 * Which mode the running run is in, as a pill beside the status.
 *
 * It was a half-width `glass-card` in a two-column row with the plan, holding one line of
 * text. On a wide screen that left roughly four hundred pixels of empty card next to the
 * single most important fact on the dashboard, which is most of what made this screen read
 * as scattered. A pill puts it where a trader already looks for run state, and costs no
 * layout at all.
 */
export function RunModePill({ live }: { live: boolean }) {
  const Icon = live ? LuRadioTower : LuEye;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-medium ${
        live ? 'bg-up/12 text-up' : 'bg-(--accent-soft) text-accent'
      }`}
    >
      <Icon size={10} className="flex-none" />
      {live ? 'Live' : 'Watch'}
    </span>
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
  // `status-flip` plays once because the panel keys this on the status, so it mounts
  // fresh on every change. Idle is left out: it is the state the page BOOTS in, and a
  // ring on first paint would announce nothing having happened.
  return (
    <span
      className={`relative inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${map.cls} ${
        status === 'idle' ? '' : 'status-flip'
      }`}
    >
      {map.label}
    </span>
  );
}

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

/**
 * Shown after a reload landed an armed run as stopped (for safety). Reassures that
 * the run + its open trades are still here and settling, and that Autopilot only
 * paused PLACING new trades — one tap re-arms.
 */
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
 * guard) gets the warning tone.
 *
 * NOTHING IS "FINISHED" WHILE MONEY IS STILL ON THE TABLE. With a trade still open the
 * run has stopped OPENING trades, not stopped: the headline says "Finishing up" and only
 * becomes "Autopilot finished" once the last one settles. The one exception is a run that
 * stopped because something broke, which keeps its alarm wording either way, since
 * softening that to "finishing up" would bury the part worth acting on.
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
  const why = reason == null ? 'You stopped it' : stopReasonLabel(reason);
  const headline = attention
    ? `Autopilot stopped. ${stopReasonLabel(reason)}.`
    : settlingCount > 0
      ? `Finishing up. ${why}.`
      : reason == null
        ? 'You stopped Autopilot.'
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
    <div className="glass-inset flex min-w-0 flex-col gap-1.5 p-2.5">
      <div className="flex items-center gap-1.5">
        <Icon size={12} style={{ color }} className="flex-none" />
        <span className="eyebrow truncate">{label}</span>
      </div>
      <div className="flex items-baseline gap-1">
        <span className="font-mono text-[18px] leading-none tabular-nums tracking-tight text-text-1">{value}</span>
        <span className="font-mono text-[10.5px] tabular-nums text-text-3">{sub}</span>
      </div>
      <div className="h-1 overflow-hidden rounded-full bg-white/6">
        {/* The width is set twice on purpose. The inline one is what the bar rests at and
            what the transition animates when a meter moves mid-run; `--fill` is the same
            number in a form the arm-in sweep keyframe can read, so the fill can start at
            zero and land exactly where CSS would have put it anyway. */}
        <div
          className="meter-fill h-full rounded-full transition-all duration-500"
          style={{ width: `${pct}%`, '--fill': `${pct}%`, background: color } as React.CSSProperties}
        />
      </div>
    </div>
  );
}

/**
 * Flash a number in the direction it just moved.
 *
 * Every terminal does this and this one did not: the spot price changed silently, so the
 * only thing saying the feed was alive was a pulse dot that would pulse just as happily
 * over a frozen number. A wash of up-teal or down-coral on the tick is the difference
 * between "there is a price here" and "the price is moving".
 *
 * Imperative on purpose. The feed ticks about once a second, and comparing against the
 * previous value in React state would re-render the whole band to change one colour, on
 * top of tripping this repo's `set-state-in-effect` rule. Adding the class a frame after
 * removing it restarts the animation even when the price moves the same way twice.
 */
function useTickFlash(value: number | null) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const prev = useRef<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    const was = prev.current;
    prev.current = value;
    if (!el || value == null || was == null || value === was) return;
    const cls = value > was ? 'tick-up' : 'tick-down';
    el.classList.remove('tick-up', 'tick-down');
    const id = requestAnimationFrame(() => el.classList.add(cls));
    return () => cancelAnimationFrame(id);
  }, [value]);
  return ref;
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
    <div className="glass-inset flex min-w-0 flex-col gap-1 p-2.5">
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
  const priceRef = useTickFlash(spot);
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-1 p-2.5">
      <span className="eyebrow flex items-center gap-1.5">
        BTC <LivePulse />
      </span>
      <div className="flex items-end gap-2">
        <span
          ref={priceRef}
          className="font-mono text-[19px] font-semibold leading-none tabular-nums tracking-tight text-text-1"
        >
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
 * The live tape, sized for the command bar.
 *
 * The bar had 778px of nothing between the page title and the Start button. This is what
 * belongs there: on a page whose whole promise is "it watches the market for you", the
 * price is the one thing that moves while nothing is running, and a header that ticks
 * reads as an instrument rather than a settings screen.
 *
 * Below `md` the bar has no room to spare, so the tape hides and the same reading stays
 * available as the first tile of the stat band (see StatBand). One component, shown in
 * whichever place the width allows, rather than two copies of the same number.
 */
export function HeaderTape({ spot, watching }: { spot: number | null; watching: number }) {
  const priceRef = useTickFlash(spot);
  return (
    <div className="hidden min-w-0 flex-1 items-center justify-center gap-3 md:flex">
      <span className="eyebrow flex flex-none items-center gap-1.5">
        BTC <LivePulse />
      </span>
      <span
        ref={priceRef}
        className="flex-none font-mono text-[15px] font-semibold leading-none tabular-nums tracking-tight text-text-1"
      >
        {spot != null ? `$${num(spot, 0)}` : '\u2014'}
      </span>
      <div className="h-6 w-24 flex-none lg:w-32">
        <Sparkline value={spot} />
      </div>
      <span className="flex-none font-mono text-[10.5px] tabular-nums text-text-3">
        {watching} market{watching === 1 ? '' : 's'}
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
    // Three tiles from `md`, where the price has moved up into the command bar's tape,
    // and four below it, where the bar has no room for one.
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 md:grid-cols-3">
      <div className="md:hidden">
        <LivePriceTile spot={spot} watching={watching} />
      </div>
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
  ranForMs,
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
  /** How long the run actually lasted, once it has stopped. */
  ranForMs: number;
  armDurationMs: number;
}) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
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
      {/* Two different questions, so two different readings. While armed the useful one
          is how long is LEFT, and the bar empties with it. Once the run is over the useful
          one is how long it actually lasted, which is not the configured length: a
          ten-minute run that hit its trade cap after four minutes was still reading
          "Ran for 10:00", because there was nothing to read but the setting. */}
      <Meter
        icon={LuTimer}
        label={armed ? 'Time left' : 'Ran for'}
        value={mmss(armed ? timeLeftMs : ranForMs)}
        sub={armed ? 'remaining' : `of ${mmss(armDurationMs)}`}
        frac={armDurationMs > 0 ? (armed ? timeLeftMs : ranForMs) / armDurationMs : 0}
        color="#9aa4af"
      />
    </div>
  );
}

/* --------------------------------- the tape ------------------------------- */

/** One row of bars, and the gap under it. Four rows is the concurrency ceiling. */
const LANE_H = 8;
const LANE_GAP = 4;

/**
 * RunTape — the run on one axis.
 *
 * The log answers "what just happened" and cannot answer "what has this thing been
 * DOING": it is reverse-chronological, every row is the same shape, and the two facts
 * that make a run legible (when the bets landed, and how long each one lived) have to be
 * reassembled out of timestamps across a scroll. Here they are the picture. Bursts,
 * cooldown gaps, overlapping bets and the moment each one decided are all readable
 * without a word.
 *
 * It sits ABOVE the log rather than replacing it, because a tape cannot carry the text,
 * the explorer links or the reasons Kelly passed. Shape first, detail underneath.
 *
 * Colour is OUTCOME, not direction: won teal, lost coral, still open a neutral white
 * (undecided, and deliberately NOT the accent, which is close enough to the up-teal that
 * a live bet read as a win), never settled a dim grey. Direction is one word away in
 * every bar's tooltip and spelled out in the row below, and encoding it here as well
 * would put two meanings on one ramp.
 */
export function RunTape({ tape, now, armed }: { tape: RunTapeData; now: number; armed: boolean }) {
  const span = Math.max(1, tape.endAt - tape.startAt);
  // Pinned at the right edge once the clock is past the axis, which happens while a
  // stopped run waits on its last settlement. "We are at the end" is the truth there.
  const head = Math.min(1, Math.max(0, (now - tape.startAt) / span));
  const height = tape.lanes * LANE_H + (tape.lanes - 1) * LANE_GAP;
  const bets = tape.trades.length;
  const passes = tape.holds.length;

  return (
    <div className="px-4 pt-3 pb-2.5">
      <div className="relative" style={{ height }}>
        {/* Quarter marks, so a gap can be read as a length rather than just a gap. */}
        {[0.25, 0.5, 0.75].map((q) => (
          <span key={q} aria-hidden className="absolute inset-y-0 w-px bg-white/6" style={{ left: `${q * 100}%` }} />
        ))}
        {/* Where the run was scheduled to end, drawn only when something ran past it. */}
        {tape.plannedEnd < 1 && (
          <span
            aria-hidden
            title="Where the run was set to end"
            className="absolute -inset-y-1 w-px bg-white/20"
            style={{ left: `${tape.plannedEnd * 100}%` }}
          />
        )}
        {tape.trades.map((t) => (
          <TapeBar key={`${t.marketId}-${t.from}`} t={t} />
        ))}
        {/* The playhead. Accent while it is still moving, quiet once it has stopped. */}
        <span
          aria-hidden
          className="absolute -top-1.5 -bottom-1.5 w-px"
          style={{ left: `${head * 100}%`, background: armed ? 'var(--accent)' : 'rgba(255,255,255,0.28)' }}
        >
          <span
            className="absolute -top-0.5 -left-[1.5px] h-1 w-1 rounded-full"
            style={{ background: armed ? 'var(--accent)' : 'rgba(255,255,255,0.4)' }}
          />
        </span>
      </div>

      {/* Every moment Kelly looked at a market and passed. Nothing happened at any of
          them, and that is the point: the gaps between bets are full of decisions. */}
      <div className="relative mt-2 h-1.5">
        {/* Keyed by index as well as time: the engine can note two markets inside one
            tick, and two holds landing on the same millisecond would collide. */}
        {tape.holds.map((h, i) => (
          <span
            key={`${h.at}-${i}`}
            title={h.text}
            className="absolute inset-y-0 w-px bg-white/22"
            style={{ left: `${h.pos * 100}%` }}
          />
        ))}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] text-text-3">
        <span className="font-mono tabular-nums">0:00</span>
        <span className="truncate">
          {bets === 0 ? 'nothing placed yet' : `${bets} bet${bets === 1 ? '' : 's'}`}
          {passes > 0 ? ` · ${passes} looked at and passed` : ''}
        </span>
        <span className="font-mono tabular-nums">{mmss(span)}</span>
      </div>
    </div>
  );
}

/** One bet's life: where it went on, and how far it got. */
function TapeBar({ t }: { t: TapeTrade }) {
  const color =
    t.outcome === 'won'
      ? 'var(--up)'
      : t.outcome === 'lost'
        ? 'var(--down)'
        : t.outcome === 'open'
          ? 'rgba(255,255,255,0.5)'
          : 'rgba(255,255,255,0.2)';
  return (
    <span
      title={t.label}
      className="absolute rounded-full"
      style={{
        left: `${t.from * 100}%`,
        // A minimum so a bet that decided almost instantly is still a mark and not a
        // gap, and so a never-settled trade (which has no length at all) still shows.
        width: `max(5px, ${(t.to - t.from) * 100}%)`,
        top: t.lane * (LANE_H + LANE_GAP),
        height: LANE_H,
        background: color,
        opacity: t.outcome === 'lost' ? 0.85 : 1,
      }}
    >
      {/* A live bet keeps pulsing at the end it has not reached yet. Same vocabulary as
          the pulse dot in the header, so "this one is still running" reads the same way
          wherever it appears. */}
      {t.outcome === 'open' && (
        <span className="absolute -right-0.5 top-1/2 flex h-1.5 w-1.5 -translate-y-1/2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-accent opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-accent" />
        </span>
      )}
    </span>
  );
}

/** The run log as a self-contained panel (its own header), so it can sit in a grid cell. */
export function RunLogPanel({
  log,
  tape,
  now,
  armed,
  ready,
}: {
  log: AutopilotLogEntry[];
  tape: RunTapeData;
  now: number;
  armed: boolean;
  ready: boolean;
}) {
  return (
    <div className="glass-card flex flex-col overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-2.5">
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
      {/* The shape of the run, above the words. The divider moved below it so the tape
          reads as part of the header rather than as the first row of the list. */}
      <RunTape tape={tape} now={now} armed={armed} />
      <div className="border-b border-white/6" />
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

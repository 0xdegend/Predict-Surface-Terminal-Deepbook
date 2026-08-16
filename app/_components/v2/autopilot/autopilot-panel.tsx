'use client';

/**
 * AutopilotPanel — the cockpit for Kelly's unattended trading.
 *
 * The trader sets their rules (which windows, which direction, a win-chance floor,
 * a leverage cap) and safety limits (a budget, a per-trade size, a trade cap, a
 * cooldown, a run length, a losing-streak stop), then arms it. While armed, the
 * engine (use-autopilot-engine) asks Kelly for her best-value pick each tick and
 * fires only the picks that clear BOTH the rules and the limits. Everything shows
 * up in the run log.
 *
 * Phase 0 is WATCH MODE: the engine runs the full live logic and records every
 * trade it WOULD place, without signing anything. Real trading (the session-key
 * fire + a Walrus receipt per trade) wires in next, behind the dry-run flag.
 *
 * House style matches the track-record + leaderboard panels: glass cards, mono
 * numerals, teal (up) / coral (down) semantics, hairline dividers.
 */
import Image from 'next/image';
import { useMemo } from 'react';
import type { IconType } from 'react-icons';
import {
  LuGauge,
  LuZap,
  LuShieldCheck,
  LuCircleCheck,
  LuHand,
  LuWallet,
  LuLayers,
  LuTimer,
  LuActivity,
  LuTrendingUp,
  LuTrendingDown,
  LuTriangleAlert,
  LuEye,
  LuTrash2,
} from 'react-icons/lu';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { MASCOT_SRC } from '@/lib/mascot';
import { useNow } from '@/lib/hooks/use-now';
import { num } from '@/lib/format';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import { useAutopilotEngine } from '@/lib/hooks/use-autopilot-engine';
import { useAutopilotStore, type AutopilotLogEntry } from '@/lib/store/autopilot-store';
import { stopReasonLabel, type Tenor, type TradeSide } from '@/lib/autopilot/policy';

interface Props {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

const TENOR_LABEL: Record<Tenor, string> = { soonest: 'Minutes', hour: '~1 hour', today: 'Longer' };
const PROB_CHOICES = [0.55, 0.6, 0.65, 0.7, 0.75];
const LEV_CHOICES = [1, 2, 3];
const COOLDOWN_CHOICES = [30_000, 60_000, 90_000, 120_000];
const DURATION_CHOICES = [15, 30, 60, 120]; // minutes

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

function durationLabel(mins: number): string {
  return mins < 60 ? `${mins}m` : mins % 60 === 0 ? `${mins / 60}h` : `${(mins / 60).toFixed(1)}h`;
}

export function AutopilotPanel({ markets, pricerSeeds }: Props) {
  const engine = useAutopilotEngine({ markets, pricerSeeds }); // runs the armed loop
  const now = useNow(1_000);

  const status = useAutopilotStore((s) => s.status);
  const rules = useAutopilotStore((s) => s.rules);
  const limits = useAutopilotStore((s) => s.limits);
  const run = useAutopilotStore((s) => s.run);
  const stopReason = useAutopilotStore((s) => s.stopReason);
  const log = useAutopilotStore((s) => s.log);
  const setRules = useAutopilotStore((s) => s.setRules);
  const setLimits = useAutopilotStore((s) => s.setLimits);
  const arm = useAutopilotStore((s) => s.arm);
  const disarm = useAutopilotStore((s) => s.disarm);
  const reset = useAutopilotStore((s) => s.reset);

  const armed = status === 'armed';
  const stopped = status === 'stopped';

  const remaining = Math.max(0, limits.budgetUsd - run.spentUsd);
  const timeLeftMs = armed ? Math.max(0, limits.armDurationMs - (now - run.armedAt)) : limits.armDurationMs;
  const openCount = useMemo(() => run.open.filter((p) => p.expiry > now).length, [run.open, now]);

  const armIssue =
    rules.tenors.length === 0
      ? 'Pick at least one window'
      : rules.sides.length === 0
        ? 'Pick at least one direction'
        : limits.perTradeUsd < 1
          ? 'Per-trade size must be at least $1'
          : limits.budgetUsd < limits.perTradeUsd
            ? 'Budget must cover at least one trade'
            : limits.maxTrades < 1
              ? 'Allow at least one trade'
              : null;
  const canArm = armIssue == null;

  function toggleTenor(t: Tenor) {
    const has = rules.tenors.includes(t);
    setRules({ tenors: has ? rules.tenors.filter((x) => x !== t) : [...rules.tenors, t] });
  }
  function toggleSide(side: TradeSide) {
    const has = rules.sides.includes(side);
    setRules({ sides: has ? rules.sides.filter((x) => x !== side) : [...rules.sides, side] });
  }

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5">
      {/* ── Hero / status ──────────────────────────────────────────────────── */}
      <div className="glass-card mb-4 flex flex-col gap-5 overflow-hidden p-5 sm:flex-row sm:items-center sm:gap-6 sm:p-6">
        <div className="relative mx-auto flex h-20 w-20 flex-none items-center justify-center sm:mx-0 sm:h-24 sm:w-24">
          <span
            aria-hidden
            className="absolute inset-0"
            style={{ background: 'radial-gradient(circle at 50% 42%, var(--accent-soft), transparent 70%)' }}
          />
          <Image src={MASCOT_SRC.thinking} alt="Kelly the fox" width={96} height={96} className="relative h-full w-full object-contain" />
        </div>

        <div className="min-w-0 flex-1">
          <p className="eyebrow mb-1 flex items-center gap-1.5">
            <LuGauge size={12} className="text-accent" /> Kelly · Autopilot
          </p>
          <div className="flex items-center gap-2.5">
            <h1 className="text-[22px] font-semibold tracking-tight text-text-1 sm:text-[26px]">Autopilot</h1>
            <StatusPill status={status} />
          </div>
          <p className="mt-1.5 max-w-lg text-[12.5px] leading-relaxed text-text-2">
            Kelly picks her best-value bet and places it for you, within the rules and budget you set. You can stop it any
            time, and every trade is logged.
          </p>
        </div>

        <div className="flex flex-none flex-col items-stretch gap-2 sm:w-40">
          {armed ? (
            <ReviewButton tone="down" onClick={() => disarm('manual', Date.now())}>
              Stop Autopilot
            </ReviewButton>
          ) : (
            <ReviewButton tone="up" onClick={() => arm(Date.now())} disabled={!canArm}>
              {stopped ? 'Arm again' : 'Arm Autopilot'}
            </ReviewButton>
          )}
          {!armed && !canArm && <p className="text-center text-[10.5px] leading-tight text-text-3">{armIssue}</p>}
          {stopped && (
            <button
              onClick={() => reset()}
              className="group glass-inset inline-flex items-center justify-center gap-1.5 px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
            >
              <LuTrash2 size={12} className="transition-colors duration-200 group-hover:text-accent" /> Clear log
            </button>
          )}
        </div>
      </div>

      {/* ── Watch-mode notice (Phase 0) ────────────────────────────────────── */}
      <div className="glass-inset mb-4 flex items-start gap-2.5 p-3.5">
        <LuEye size={15} className="mt-px flex-none text-accent" />
        <p className="text-[12px] leading-relaxed text-text-2">
          <span className="font-medium text-text-1">Watch mode.</span> Kelly runs the full live logic and shows every
          trade she would place, without spending anything. Live trading turns on in the next update.
        </p>
      </div>

      {/* ── Stop banner ────────────────────────────────────────────────────── */}
      {stopped && stopReason && (
        <div className="mb-4 flex items-center gap-2.5 rounded-lg border border-down/40 bg-down/10 p-3.5 text-[12.5px] text-down">
          <LuTriangleAlert size={15} className="flex-none" />
          <span>
            Autopilot stopped. <span className="font-medium">{stopReasonLabel(stopReason)}.</span>
          </span>
        </div>
      )}

      {/* ── Live meters ────────────────────────────────────────────────────── */}
      <div className="mb-4 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        <Meter
          icon={LuWallet}
          label="Budget"
          value={`$${num(run.spentUsd, 0)}`}
          sub={`of $${num(limits.budgetUsd, 0)}`}
          frac={limits.budgetUsd > 0 ? run.spentUsd / limits.budgetUsd : 0}
          color="var(--up)"
        />
        <Meter
          icon={LuActivity}
          label="Trades"
          value={num(run.tradeCount, 0)}
          sub={`of ${num(limits.maxTrades, 0)}`}
          frac={limits.maxTrades > 0 ? run.tradeCount / limits.maxTrades : 0}
          color="#6aa6e6"
        />
        <Meter
          icon={LuLayers}
          label="Open now"
          value={num(openCount, 0)}
          sub={`of ${num(limits.maxConcurrent, 0)}`}
          frac={limits.maxConcurrent > 0 ? openCount / limits.maxConcurrent : 0}
          color="#c9a0ff"
        />
        <Meter
          icon={LuTimer}
          label={armed ? 'Time left' : 'Runs for'}
          value={mmss(timeLeftMs)}
          sub={armed ? 'remaining' : 'once armed'}
          frac={armed && limits.armDurationMs > 0 ? 1 - timeLeftMs / limits.armDurationMs : 0}
          color="#9aa4af"
        />
      </div>

      {/* ── Settings (editable when idle/stopped, summary when armed) ───────── */}
      {armed ? (
        <SettingsSummary rules={rules} limits={limits} remaining={remaining} />
      ) : (
        <div className="mb-4 grid gap-3 md:grid-cols-2">
          {/* Your rules */}
          <div className="glass-card p-4">
            <p className="eyebrow mb-3 flex items-center gap-1.5">
              <LuGauge size={12} className="text-accent" /> Your rules
            </p>
            <div className="flex flex-col gap-3.5">
              <Field label="Only bet at least this likely">
                {PROB_CHOICES.map((p) => (
                  <Chip key={p} active={Math.abs(rules.minProb - p) < 1e-9} onClick={() => setRules({ minProb: p })}>
                    {Math.round(p * 100)}%
                  </Chip>
                ))}
              </Field>
              <Field label="Windows to trade">
                {(['soonest', 'hour', 'today'] as Tenor[]).map((t) => (
                  <Chip key={t} active={rules.tenors.includes(t)} onClick={() => toggleTenor(t)}>
                    {TENOR_LABEL[t]}
                  </Chip>
                ))}
              </Field>
              <Field label="Direction">
                <Chip active={rules.sides.includes('up')} onClick={() => toggleSide('up')}>
                  <LuTrendingUp size={12} className="mr-1 inline text-up" /> UP
                </Chip>
                <Chip active={rules.sides.includes('down')} onClick={() => toggleSide('down')}>
                  <LuTrendingDown size={12} className="mr-1 inline text-down" /> DOWN
                </Chip>
                <Chip active={false} disabled title="Range bets come next">
                  Range · soon
                </Chip>
              </Field>
              <Field label="Max leverage">
                {LEV_CHOICES.map((l) => (
                  <Chip key={l} active={rules.maxLeverage === l} onClick={() => setRules({ maxLeverage: l })}>
                    {l}x
                  </Chip>
                ))}
              </Field>
            </div>
          </div>

          {/* Safety limits */}
          <div className="glass-card p-4">
            <p className="eyebrow mb-3 flex items-center gap-1.5">
              <LuShieldCheck size={12} className="text-accent" /> Safety limits
            </p>
            <div className="flex flex-col gap-3.5">
              <div className="grid grid-cols-2 gap-3">
                <NumField
                  label="Total budget"
                  prefix="$"
                  value={limits.budgetUsd}
                  min={1}
                  max={100_000}
                  onChange={(v) => setLimits({ budgetUsd: v })}
                />
                <NumField
                  label="Per trade"
                  prefix="$"
                  value={limits.perTradeUsd}
                  min={1}
                  max={Math.max(1, limits.budgetUsd)}
                  onChange={(v) => setLimits({ perTradeUsd: v })}
                />
                <NumField
                  label="Max trades"
                  value={limits.maxTrades}
                  min={1}
                  max={100}
                  onChange={(v) => setLimits({ maxTrades: v })}
                />
                <NumField
                  label="Stop after losses"
                  value={limits.maxConsecutiveLosses}
                  min={1}
                  max={20}
                  onChange={(v) => setLimits({ maxConsecutiveLosses: v })}
                />
              </div>
              <Field label="Cooldown between trades">
                {COOLDOWN_CHOICES.map((c) => (
                  <Chip key={c} active={limits.cooldownMs === c} onClick={() => setLimits({ cooldownMs: c })}>
                    {c / 1000}s
                  </Chip>
                ))}
              </Field>
              <Field label="Run for">
                {DURATION_CHOICES.map((m) => (
                  <Chip key={m} active={limits.armDurationMs === m * 60_000} onClick={() => setLimits({ armDurationMs: m * 60_000 })}>
                    {durationLabel(m)}
                  </Chip>
                ))}
              </Field>
            </div>
          </div>
        </div>
      )}

      {/* ── Run log ────────────────────────────────────────────────────────── */}
      <div className="mb-2 flex items-center gap-2">
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
        {engine.ready ? null : (
          <span className="ml-auto text-[10.5px] text-text-3">Waiting for the live feed…</span>
        )}
      </div>
      <div className="glass-card overflow-hidden">
        {log.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
            <LuGauge size={22} className="text-text-3" />
            <p className="text-[13px] text-text-1">Nothing yet.</p>
            <p className="max-w-xs text-[12px] leading-relaxed text-text-2">
              Arm Autopilot and Kelly starts watching the surface. Every trade she would place shows up here as it
              happens.
            </p>
          </div>
        ) : (
          <div className="rows-divided max-h-[22rem] overflow-y-auto">
            {log.map((e) => (
              <LogRow key={e.id} entry={e} now={now} />
            ))}
          </div>
        )}
      </div>

      {/* ── Footer note ────────────────────────────────────────────────────── */}
      <p className="mt-4 flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-3">
        <LuShieldCheck size={12} className="mt-px flex-none" />
        <span>
          When live trading is on, Autopilot spends only the budget you pre-commit to your session key. The key can&rsquo;t
          spend past it, add to it, or withdraw, and you can stop the run at any moment.
        </span>
      </p>
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

function StatusPill({ status }: { status: 'idle' | 'armed' | 'stopped' }) {
  const map = {
    idle: { label: 'Idle', cls: 'bg-white/5 text-text-3' },
    armed: { label: 'Running', cls: 'bg-(--accent-soft) text-up' },
    stopped: { label: 'Stopped', cls: 'bg-(--down-soft) text-down' },
  }[status];
  return <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10.5px] font-medium ${map.cls}`}>{map.label}</span>;
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

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <div className="flex flex-wrap gap-1.5">{children}</div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  disabled,
  title,
  children,
}: {
  active: boolean;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-all duration-150 ${
        active
          ? 'border border-(--accent-line) bg-(--accent-soft) text-text-1'
          : 'glass-inset text-text-2 hover:text-text-1'
      } ${disabled ? 'cursor-not-allowed opacity-40' : ''}`}
    >
      {children}
    </button>
  );
}

function NumField({
  label,
  value,
  onChange,
  min,
  max,
  prefix,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min: number;
  max: number;
  prefix?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <div className="glass-inset flex items-center gap-1 px-2.5">
        {prefix && <span className="text-[13px] text-text-3">{prefix}</span>}
        <input
          type="number"
          inputMode="numeric"
          value={value}
          min={min}
          max={max}
          onChange={(e) => {
            const v = Number(e.target.value);
            if (!Number.isNaN(v)) onChange(clamp(Math.round(v), min, max));
          }}
          className="w-full min-w-0 bg-transparent py-2 text-[16px] font-mono tabular-nums text-text-1 outline-none"
        />
      </div>
    </label>
  );
}

function SettingsSummary({
  rules,
  limits,
  remaining,
}: {
  rules: ReturnType<typeof useAutopilotStore.getState>['rules'];
  limits: ReturnType<typeof useAutopilotStore.getState>['limits'];
  remaining: number;
}) {
  const sides = rules.sides.map((s) => (s === 'range' ? 'range' : s.toUpperCase())).join(' / ') || 'none';
  const windows = rules.tenors.map((t) => TENOR_LABEL[t]).join(', ') || 'none';
  return (
    <div className="glass-card mb-4 flex flex-wrap gap-x-6 gap-y-2 p-4 text-[12px]">
      <SummaryItem label="Betting" value={`${sides} · ${Math.round(rules.minProb * 100)}%+ · up to ${rules.maxLeverage}x`} />
      <SummaryItem label="Windows" value={windows} />
      <SummaryItem label="Per trade" value={`$${num(limits.perTradeUsd, 0)}`} />
      <SummaryItem label="Budget left" value={`$${num(remaining, 0)}`} />
      <SummaryItem label="Cooldown" value={`${limits.cooldownMs / 1000}s`} />
    </div>
  );
}

function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="eyebrow">{label}</span>
      <span className="font-mono text-[12.5px] tabular-nums text-text-1">{value}</span>
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
      <span className="flex-none font-mono text-[10.5px] tabular-nums text-text-3">{ago(entry.at, now)}</span>
    </div>
  );
}

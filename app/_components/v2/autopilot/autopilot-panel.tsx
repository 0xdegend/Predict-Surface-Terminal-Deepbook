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
import { useEffect, useMemo, useState } from 'react';
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
  LuRadioTower,
  LuExternalLink,
  LuHistory,
  LuChevronDown,
  LuInbox,
  LuClock,
} from 'react-icons/lu';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { MASCOT_SRC } from '@/lib/mascot';
import { useNow } from '@/lib/hooks/use-now';
import { num } from '@/lib/format';
import { toQuote } from '@/config/scale';
import { predictV2Config } from '@/config/predict';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import { useAutopilotEngine, type AutopilotOpenView, type AutopilotPerf } from '@/lib/hooks/use-autopilot-engine';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useAutopilotStore, type AutopilotLogEntry, type RunResult, type RunTradeResult } from '@/lib/store/autopilot-store';
import { stopReasonLabel, stopReasonKind, type StopReason, type Tenor, type TradeSide } from '@/lib/autopilot/policy';

/** How the session is funded when arming LIVE trading (a per-run choice). */
type FundingMode = 'deposit' | 'existing';

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

/** Signed dollar amount, cents shown (PnL is small). e.g. +$0.84, -$5.00. */
function signedUsd(v: number): string {
  return `${v >= 0 ? '+' : '-'}$${Math.abs(v).toFixed(2)}`;
}

/** Color class for a signed number (a small dead-band reads flat as neutral). */
function pnlClass(v: number): string {
  return v > 0.005 ? 'text-up' : v < -0.005 ? 'text-down' : 'text-text-2';
}

export function AutopilotPanel({ markets, pricerSeeds }: Props) {
  const acct = usePredictAccountV2(); // arming live trading approves the session key
  const engine = useAutopilotEngine({ markets, pricerSeeds, acct }); // runs the armed loop
  const now = useNow(1_000);

  const status = useAutopilotStore((s) => s.status);
  const rules = useAutopilotStore((s) => s.rules);
  const limits = useAutopilotStore((s) => s.limits);
  const run = useAutopilotStore((s) => s.run);
  const dryRun = useAutopilotStore((s) => s.dryRun);
  const stopReason = useAutopilotStore((s) => s.stopReason);
  const interruptedByReload = useAutopilotStore((s) => s.interruptedByReload);
  const log = useAutopilotStore((s) => s.log);
  const setRules = useAutopilotStore((s) => s.setRules);
  const setLimits = useAutopilotStore((s) => s.setLimits);
  const setDryRun = useAutopilotStore((s) => s.setDryRun);
  const arm = useAutopilotStore((s) => s.arm);
  const disarm = useAutopilotStore((s) => s.disarm);
  const reset = useAutopilotStore((s) => s.reset);
  const history = useAutopilotStore((s) => s.history);
  const deleteResult = useAutopilotStore((s) => s.deleteResult);
  const clearHistory = useAutopilotStore((s) => s.clearHistory);

  const [fundingMode, setFundingMode] = useState<FundingMode>('deposit');
  const [arming, setArming] = useState(false);
  const [view, setView] = useState<'cockpit' | 'results'>('cockpit');

  // Load the persisted run + results after mount (see skipHydration in the store): a
  // reload restores an in-progress run's open trades, and _resumeAfterReload lands it
  // stopped so it never resumes placing trades on its own.
  useEffect(() => {
    void useAutopilotStore.persist.rehydrate();
  }, []);

  const armed = status === 'armed';
  const stopped = status === 'stopped';
  const live = !dryRun; // "live trading" vs "watch mode"

  const remaining = Math.max(0, limits.budgetUsd - run.spentUsd);
  const timeLeftMs = armed ? Math.max(0, limits.armDurationMs - (now - run.armedAt)) : limits.armDurationMs;
  const openCount = useMemo(() => run.open.filter((p) => p.expiry > now).length, [run.open, now]);

  // Basic setup issues (either mode).
  const settingIssue =
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
  // Extra requirements that only apply to LIVE trading (real signing).
  const liveIssue = live
    ? !acct.sessionsEnabled
      ? 'Live trading is not available on this deployment yet'
      : !acct.owner
        ? 'Connect your wallet to trade live'
        : !acct.wrapperExists
          ? 'Set up your trading account first (place one trade from the ticket)'
          : fundingMode === 'deposit' && (acct.walletDusdcBase ?? 0n) < toQuote(limits.budgetUsd)
            ? `Not enough DUSDC in your wallet to deposit $${num(limits.budgetUsd, 0)}`
            : fundingMode === 'existing' && acct.balanceBase < toQuote(limits.perTradeUsd)
              ? `Your trading account needs at least $${num(limits.perTradeUsd, 0)} to trade`
              : null
    : null;
  const armIssue = settingIssue ?? liveIssue;
  const canArm = armIssue == null && !arming;

  const sessionReady = acct.sessionCanTrade;
  const sessionExpiresInMs = acct.sessionExpiryMs != null ? Math.max(0, acct.sessionExpiryMs - now) : null;

  /**
   * Arm the run. Watch mode arms immediately. Live mode first turns on the session
   * key (one signature): "deposit" pre-commits the budget into the trading account
   * so the session's on-chain ceiling equals it; "existing" reuses the account's
   * current balance (no deposit, and no signature at all when a session is already
   * live). Only after the session is authorized do we flip the run to armed.
   */
  async function handleArm() {
    if (!live) {
      arm(Date.now());
      return;
    }
    if (!acct.sessionsEnabled || !acct.owner || !acct.wrapperExists) return;
    setArming(true);
    try {
      if (fundingMode === 'deposit') {
        const digest = await acct.startSession({ budgetBase: toQuote(limits.budgetUsd), duration: '24h' });
        if (!digest) return; // cancelled or failed — acct.error explains why
      } else if (!acct.sessionCanTrade) {
        // Reuse the account balance: authorize the key with no fresh deposit.
        const digest = await acct.startSession({ budgetBase: 0n, duration: '24h' });
        if (!digest) return;
      }
      arm(Date.now());
    } finally {
      setArming(false);
    }
  }

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
      {/* ── View tabs (cockpit vs saved results) ───────────────────────────── */}
      <ViewTabs view={view} onView={setView} resultCount={history.length} running={armed} />

      {view === 'results' ? (
        <ResultsView history={history} onDelete={deleteResult} onClear={clearHistory} />
      ) : (
        <>
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
            <StatusPill status={status} settling={stopped && openCount > 0} />
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
            <ReviewButton tone="up" onClick={handleArm} disabled={!canArm}>
              {arming
                ? live && !sessionReady
                  ? 'Approve in wallet…'
                  : 'Arming…'
                : live
                  ? 'Arm live trading'
                  : stopped
                    ? 'Arm again'
                    : 'Arm watch mode'}
            </ReviewButton>
          )}
          {!armed && armIssue && <p className="text-center text-[10.5px] leading-tight text-text-3">{armIssue}</p>}
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

      {/* ── Trading mode (watch vs live) ───────────────────────────────────── */}
      <TradingModeCard
        armed={armed}
        live={live}
        onSetLive={(on) => setDryRun(!on)}
        fundingMode={fundingMode}
        onSetFunding={setFundingMode}
        budgetUsd={limits.budgetUsd}
        sessionReady={sessionReady}
        sessionExpiresInMs={sessionExpiresInMs}
        error={acct.error}
      />

      {/* ── Stop / reload banner ───────────────────────────────────────────── */}
      {stopped &&
        (interruptedByReload ? (
          <ReloadBanner settlingCount={openCount} />
        ) : (
          <StoppedBanner reason={stopReason} settlingCount={openCount} />
        ))}

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

      {/* ── Live performance + open trades ─────────────────────────────────── */}
      {(engine.positions.length > 0 || engine.perf.wins + engine.perf.losses > 0) && (
        <PerformancePanel perf={engine.perf} positions={engine.positions} />
      )}

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
          Live trading places bets with your session key, which can only spend your trading-account balance. It can&rsquo;t
          withdraw or move money out, Autopilot stops at the budget and limits you set, and you can stop the run at any
          moment. Depositing a fresh budget pins the on-chain ceiling to exactly that amount.
        </span>
      </p>
        </>
      )}
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

function ViewTabs({
  view,
  onView,
  resultCount,
  running,
}: {
  view: 'cockpit' | 'results';
  onView: (v: 'cockpit' | 'results') => void;
  resultCount: number;
  running: boolean;
}) {
  return (
    <div className="mb-4 flex items-center gap-1 rounded-lg bg-white/4 p-1">
      <ViewTab active={view === 'cockpit'} onClick={() => onView('cockpit')}>
        <span className="flex items-center gap-1.5">
          <LuGauge size={13} /> Autopilot
          {running && (
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-75" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" />
            </span>
          )}
        </span>
      </ViewTab>
      <ViewTab active={view === 'results'} onClick={() => onView('results')}>
        <span className="flex items-center gap-1.5">
          <LuHistory size={13} /> Results
          {resultCount > 0 && (
            <span className="rounded-full bg-white/8 px-1.5 py-px font-mono text-[10px] tabular-nums text-text-2">
              {resultCount}
            </span>
          )}
        </span>
      </ViewTab>
    </div>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded-md px-3 py-2 text-[12.5px] font-medium transition-all duration-150 ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-3 hover:text-text-1'
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------- results -------------------------------- */

function fmtWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function ResultsView({
  history,
  onDelete,
  onClear,
}: {
  history: RunResult[];
  onDelete: (id: string) => void;
  onClear: () => void;
}) {
  if (history.length === 0) {
    return (
      <div className="glass-card flex flex-col items-center gap-2 px-4 py-14 text-center">
        <LuInbox size={24} className="text-text-3" />
        <p className="text-[13px] text-text-1">No finished runs yet.</p>
        <p className="max-w-xs text-[12px] leading-relaxed text-text-2">
          Arm Autopilot from the Autopilot tab. When a run ends, its results are saved here so you can see how Kelly did
          over time.
        </p>
      </div>
    );
  }
  const net = history.reduce((a, r) => a + r.realizedPnlUsd, 0);
  const wins = history.reduce((a, r) => a + r.wins, 0);
  const losses = history.reduce((a, r) => a + r.losses, 0);
  const resolved = wins + losses;
  return (
    <div className="flex flex-col gap-3">
      {/* All-time summary across saved runs */}
      <div className="glass-card flex items-center justify-between gap-3 p-4">
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow flex items-center gap-1.5">
            <LuHistory size={12} className="text-accent" /> All-time results
          </span>
          <span className={`font-mono text-[22px] font-semibold leading-none tabular-nums ${pnlClass(net)}`}>
            {signedUsd(net)}
          </span>
          <span className="font-mono text-[11px] tabular-nums text-text-3">
            {history.length} run{history.length === 1 ? '' : 's'} · {wins}W / {losses}L
            {resolved > 0 ? ` · ${Math.round((wins / resolved) * 100)}%` : ''}
          </span>
        </div>
        <button
          onClick={onClear}
          className="group glass-inset inline-flex items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
        >
          <LuTrash2 size={12} className="transition-colors duration-200 group-hover:text-accent" /> Clear all
        </button>
      </div>

      {/* One card per finished run */}
      <div className="flex flex-col gap-2.5">
        {history.map((r) => (
          <RunResultCard key={r.id} r={r} onDelete={() => onDelete(r.id)} />
        ))}
      </div>
    </div>
  );
}

function RunResultCard({ r, onDelete }: { r: RunResult; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const resolved = r.wins + r.losses;
  const stopLabel = r.stopReason === 'manual' ? 'You stopped it' : stopReasonLabel(r.stopReason);
  return (
    <div className="glass-card overflow-hidden">
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-3 px-4 py-3 text-left">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[12.5px] tabular-nums text-text-1">{fmtWhen(r.endedAt)}</span>
            <ModeChip dryRun={r.dryRun} />
          </div>
          <div className="mt-0.5 truncate font-mono text-[10.5px] tabular-nums text-text-3">
            {r.tradeCount} trade{r.tradeCount === 1 ? '' : 's'} · {r.wins}W/{r.losses}L
            {resolved > 0 ? ` · ${Math.round((r.wins / resolved) * 100)}%` : ''}
            {r.pendingCount > 0 ? ` · ${r.pendingCount} pending` : ''} · {stopLabel}
          </div>
        </div>
        <span className={`flex-none font-mono text-[15px] font-semibold tabular-nums ${pnlClass(r.realizedPnlUsd)}`}>
          {signedUsd(r.realizedPnlUsd)}
        </span>
        <LuChevronDown size={15} className={`flex-none text-text-3 transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="border-t border-white/6">
          {r.trades.length === 0 ? (
            <p className="px-4 py-3 text-[11.5px] text-text-3">No trades recorded for this run.</p>
          ) : (
            <div className="rows-divided max-h-80 overflow-y-auto">
              {r.trades.map((t, i) => (
                <ResultTradeRow key={`${t.marketId}-${t.at}-${i}`} t={t} />
              ))}
            </div>
          )}
          <div className="flex justify-end border-t border-white/6 px-3 py-2">
            <button
              onClick={onDelete}
              className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[10.5px] font-medium text-text-3 transition-colors hover:text-down"
            >
              <LuTrash2 size={11} /> Remove
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function ModeChip({ dryRun }: { dryRun: boolean }) {
  return dryRun ? (
    <span className="inline-flex items-center gap-1 rounded-full bg-white/6 px-1.5 py-px text-[9.5px] font-medium text-text-3">
      <LuEye size={9} /> Watch
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 rounded-full bg-(--up-soft) px-1.5 py-px text-[9.5px] font-medium text-up">
      <LuRadioTower size={9} /> Live
    </span>
  );
}

function ResultTradeRow({ t }: { t: RunTradeResult }) {
  const dir = t.side === 'range' ? 'RANGE' : t.side.toUpperCase();
  const dirCls = t.side === 'up' ? 'text-up' : t.side === 'down' ? 'text-down' : 'text-text-1';
  const label = t.side === 'range' ? `$${num(t.lower ?? 0, 0)}–$${num(t.higher ?? 0, 0)}` : `$${num(t.strike ?? 0, 0)}`;
  return (
    <div className="flex items-center gap-2.5 px-4 py-2">
      <span className={`w-12 flex-none font-mono text-[11px] font-semibold ${dirCls}`}>{dir}</span>
      <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] tabular-nums text-text-1">
        {label} <span className="text-text-3">· ${num(t.stake, 0)} · {Math.round(t.entryProb * 100)}%</span>
      </span>
      <OutcomeChip outcome={t.outcome} />
      <span
        className={`w-16 flex-none text-right font-mono text-[12px] tabular-nums ${
          t.outcome === 'pending' ? 'text-text-3' : pnlClass(t.pnlUsd)
        }`}
      >
        {t.outcome === 'pending' ? '—' : signedUsd(t.pnlUsd)}
      </span>
    </div>
  );
}

function OutcomeChip({ outcome }: { outcome: RunTradeResult['outcome'] }) {
  const map = {
    won: { label: 'Won', cls: 'bg-(--up-soft) text-up' },
    lost: { label: 'Lost', cls: 'bg-(--down-soft) text-down' },
    pending: { label: 'Pending', cls: 'bg-white/6 text-text-3' },
  }[outcome];
  return <span className={`flex-none rounded-full px-1.5 py-px text-[9.5px] font-medium ${map.cls}`}>{map.label}</span>;
}

function hoursMins(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function TradingModeCard({
  armed,
  live,
  onSetLive,
  fundingMode,
  onSetFunding,
  budgetUsd,
  sessionReady,
  sessionExpiresInMs,
  error,
}: {
  armed: boolean;
  live: boolean;
  onSetLive: (on: boolean) => void;
  fundingMode: FundingMode;
  onSetFunding: (m: FundingMode) => void;
  budgetUsd: number;
  sessionReady: boolean;
  sessionExpiresInMs: number | null;
  error: string | null;
}) {
  // While armed, the mode is locked in — show a compact running banner, no controls.
  if (armed) {
    return (
      <div
        className={`glass-inset mb-4 flex items-start gap-2.5 p-3.5 ${live ? 'border-up/30' : ''}`}
      >
        {live ? <LuRadioTower size={15} className="mt-px flex-none text-up" /> : <LuEye size={15} className="mt-px flex-none text-accent" />}
        <p className="text-[12px] leading-relaxed text-text-2">
          <span className="font-medium text-text-1">{live ? 'Live trading.' : 'Watch mode.'}</span>{' '}
          {live
            ? 'Kelly is placing real bets with your session key, within your budget and limits.'
            : 'Kelly runs the full live logic and shows every trade she would place, without spending anything.'}
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card mb-4 flex flex-col gap-3.5 p-4">
      {/* Watch vs Live segmented toggle */}
      <div className="grid grid-cols-2 gap-1.5 rounded-lg bg-white/4 p-1">
        <ModeTab active={!live} icon={LuEye} label="Watch mode" sub="No spending" onClick={() => onSetLive(false)} />
        <ModeTab active={live} icon={LuRadioTower} label="Live trading" sub="Real DUSDC" onClick={() => onSetLive(true)} tone="up" />
      </div>

      {!live ? (
        <p className="text-[12px] leading-relaxed text-text-2">
          Kelly runs the full live logic and shows every trade she would place, without spending anything. A safe way to
          watch her think before you turn on real trades.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {sessionReady ? (
            <p className="flex items-center gap-1.5 text-[12px] text-text-2">
              <LuShieldCheck size={13} className="flex-none text-up" />
              Instant trading is on{sessionExpiresInMs != null ? `, expires in ${hoursMins(sessionExpiresInMs)}` : ''}.
            </p>
          ) : (
            <p className="text-[12px] leading-relaxed text-text-2">
              You&rsquo;ll approve one signature to turn on your session key. After that, Kelly places bets with no
              wallet pop-ups until you stop.
            </p>
          )}

          <div className="flex flex-col gap-1.5">
            <span className="eyebrow">Fund it with</span>
            <div className="grid gap-1.5 sm:grid-cols-2">
              <FundingOption
                active={fundingMode === 'deposit'}
                onClick={() => onSetFunding('deposit')}
                title={`Deposit $${num(budgetUsd, 0)}`}
                desc="One signature moves your budget into the account. The session can never spend past it."
              />
              <FundingOption
                active={fundingMode === 'existing'}
                onClick={() => onSetFunding('existing')}
                title="Use account balance"
                desc={sessionReady ? 'Trade from what you already have. No signature needed.' : 'Trade from your existing account balance.'}
              />
            </div>
          </div>

          {error && (
            <p className="flex items-start gap-1.5 rounded-lg border border-down/40 bg-down/10 p-2.5 text-[11.5px] leading-relaxed text-down">
              <LuTriangleAlert size={13} className="mt-px flex-none" />
              {error}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function ModeTab({
  active,
  icon: Icon,
  label,
  sub,
  onClick,
  tone,
}: {
  active: boolean;
  icon: IconType;
  label: string;
  sub: string;
  onClick: () => void;
  tone?: 'up';
}) {
  const activeCls = tone === 'up' ? 'bg-(--up-soft) text-up' : 'bg-(--accent-soft) text-text-1';
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-md px-3 py-2 transition-all duration-150 ${
        active ? activeCls : 'text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={14} className="flex-none" />
      <span className="flex flex-col items-start leading-tight">
        <span className="text-[12.5px] font-medium">{label}</span>
        <span className="text-[10px] opacity-70">{sub}</span>
      </span>
    </button>
  );
}

function FundingOption({
  active,
  onClick,
  title,
  desc,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  desc: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex flex-col gap-1 rounded-lg border p-3 text-left transition-all duration-150 ${
        active ? 'border-(--accent-line) bg-(--accent-soft)' : 'glass-inset border-transparent hover:border-white/10'
      }`}
    >
      <span className="flex items-center gap-1.5 text-[12.5px] font-medium text-text-1">
        <span
          className={`inline-block h-3 w-3 flex-none rounded-full border ${
            active ? 'border-accent bg-accent' : 'border-white/25'
          }`}
        />
        {title}
      </span>
      <span className="pl-4.5 text-[10.5px] leading-relaxed text-text-3">{desc}</span>
    </button>
  );
}

function PerformancePanel({ perf, positions }: { perf: AutopilotPerf; positions: AutopilotOpenView[] }) {
  const resolved = perf.wins + perf.losses;
  return (
    <div className="mb-4 flex flex-col gap-3">
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

function StatusPill({ status, settling }: { status: 'idle' | 'armed' | 'stopped'; settling?: boolean }) {
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
function ReloadBanner({ settlingCount }: { settlingCount: number }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-lg border border-(--accent-line) bg-(--accent-soft) p-3.5 text-[12.5px] text-text-1">
      <LuClock size={15} className="mt-px flex-none text-accent" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-medium">Picked up where you left off.</span>
        <span className="text-[11.5px] leading-relaxed text-text-2">
          {settlingCount > 0
            ? `Your ${settlingCount} open trade${settlingCount === 1 ? ' is' : 's are'} still here and settling. `
            : ''}
          Autopilot paused placing new trades when the page reloaded, so nothing traded on its own. Arm again to keep it
          going.
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
function StoppedBanner({ reason, settlingCount }: { reason: StopReason | null; settlingCount: number }) {
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
        {settlingCount > 0 && (
          <span className="text-[11.5px] leading-relaxed opacity-90">
            {settlingCount} trade{settlingCount === 1 ? '' : 's'} still open. Autopilot won&rsquo;t place any new trades,
            and {settlingCount === 1 ? 'it finishes' : 'they finish'} on {settlingCount === 1 ? 'its' : 'their'} own and
            land in your results.
          </span>
        )}
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

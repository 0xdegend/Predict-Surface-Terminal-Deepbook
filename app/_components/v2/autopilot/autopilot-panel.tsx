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
 * This file is now just the orchestration: page state, the arm flow, and the layout
 * that composes the three screens. The screens themselves live beside it, because at
 * 2,448 lines this was one file holding setup, the running dashboard, saved results,
 * a chat and a modal:
 *
 *   setup.tsx            the Auto/Manual fork and the manual controls
 *   kelly-setup-card.tsx Auto mode, Kelly's setup conversation
 *   arm-confirm.tsx      the last screen before a run starts
 *   live.tsx             the running dashboard
 *   results.tsx          saved runs
 *   next-pick.tsx        what would happen if you armed right now
 *   shared.tsx           the vocabulary more than one of them needs
 *
 * House style matches the track-record + leaderboard panels: glass cards, mono
 * numerals, teal (up) / coral (down) semantics, hairline dividers.
 */
import Image from 'next/image';
import { useEffect, useMemo, useState } from 'react';
import { LuGauge, LuHistory, LuShieldCheck, LuTrash2, LuTriangleAlert } from 'react-icons/lu';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { MASCOT_SRC } from '@/lib/mascot';
import { useNow } from '@/lib/hooks/use-now';
import { num } from '@/lib/format';
import { toQuote } from '@/config/scale';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import { useAutopilotEngine } from '@/lib/hooks/use-autopilot-engine';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useAutopilotStore } from '@/lib/store/autopilot-store';
import type { Tenor, TradeSide } from '@/lib/autopilot/policy';
import { type PresetId, matchPreset, presetPatch } from '@/lib/autopilot/presets';
import type { ResolvedSetup } from '@/lib/autopilot/setup-parser';
import { NextPick } from './next-pick';
import { type FundingMode, type SetupMode } from './shared';
import { CustomizeSection, MoneyCard, PlanDetails, PlanLine, PresetPicker, SetupModeTabs } from './setup';
import { KellySetupCard } from './kelly-setup-card';
import { ArmConfirmModal } from './arm-confirm';
import { MetersStrip, PerformancePanel, ReloadBanner, RunLogPanel, RunningModeBanner, StatBand, StatusPill, StoppedBanner } from './live';
import { ResultsView } from './results';

interface Props {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
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
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false); // arm-time confirm (live only)
  // Auto (tell Kelly) vs Manual (set the controls yourself). Null means "not chosen
  // yet", which resolves below off the track record rather than being pinned at first
  // render: `history` rehydrates from storage in an effect, so a plain useState seed
  // would always read as a first-time trader.
  const [setupModeChoice, setSetupModeChoice] = useState<SetupMode | null>(null);

  // Load the persisted run + results after mount (see skipHydration in the store): a
  // reload restores an in-progress run's open trades, and _resumeAfterReload lands it
  // stopped so it never resumes placing trades on its own.
  useEffect(() => {
    void useAutopilotStore.persist.rehydrate();
  }, []);

  const armed = status === 'armed';
  const stopped = status === 'stopped';
  const live = !dryRun; // "live trading" vs "watch mode"
  // A first-time trader gets Auto (say it in words); anyone with runs behind them gets
  // the controls straight away. Either way one tap switches.
  const setupMode: SetupMode = setupModeChoice ?? (history.length === 0 ? 'auto' : 'manual');

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
  // Live blockers that no choice on this screen can clear: no sessions, no wallet, no
  // trading account. These gate the Start button itself.
  const liveSetupIssue = live
    ? !acct.sessionsEnabled
      ? 'Live trading is not available on this deployment yet'
      : !acct.owner
        ? 'Connect your wallet to trade live'
        : !acct.wrapperExists
          ? 'Set up your trading account first (place one trade from the ticket)'
          : null
    : null;
  // Whether the CHOSEN funding route can actually cover the run. Kept separate because
  // the funding choice now lives inside the confirm: folding this into the Start button
  // would disable the only door to the screen where you can switch to the other route.
  const fundingIssue = live
    ? fundingMode === 'deposit' && (acct.walletDusdcBase ?? 0n) < toQuote(limits.budgetUsd)
      ? `Not enough DUSDC in your wallet to deposit $${num(limits.budgetUsd, 0)}`
      : fundingMode === 'existing' && acct.balanceBase < toQuote(limits.perTradeUsd)
        ? `Your trading account needs at least $${num(limits.perTradeUsd, 0)} to trade`
        : null
    : null;
  // Only a broken SETUP keeps you out of the confirm. Live-specific blockers are
  // deliberately NOT folded in here: the mode itself is now chosen inside the dialog,
  // so gating the door on a live problem would lock you out of the screen where you
  // could have picked Watch instead. Same reasoning as the funding split.
  const armIssue = settingIssue;
  const canArm = armIssue == null && !arming;
  const confirmIssue = live ? (settingIssue ?? liveSetupIssue ?? fundingIssue) : settingIssue;
  const canConfirm = confirmIssue == null && !arming;

  const sessionReady = acct.sessionCanTrade;
  const sessionExpiresInMs = acct.sessionExpiryMs != null ? Math.max(0, acct.sessionExpiryMs - now) : null;

  /**
   * Arm the run. Watch mode arms immediately. Live mode first turns on the session
   * key (one signature): "deposit" pre-commits the budget into the trading account
   * so the session's on-chain ceiling equals it; "existing" reuses the account's
   * current balance (no deposit, and no signature at all when a session is already
   * live). Only after the session is authorized do we flip the run to armed.
   */
  /** Open the confirm. Watch and live both route through it: the mode is picked there. */
  function handleStart() {
    setConfirmOpen(true);
  }

  async function handleArm() {
    if (!live) {
      // Watch spends nothing, so it arms straight from the confirm with no wallet step.
      // The close has to happen on THIS path too: an early return here is what left the
      // dialog sitting open over a running dashboard.
      arm(Date.now());
      setConfirmOpen(false);
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
      setConfirmOpen(false);
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

  // Which style the current config matches (null = the trader customized away from all).
  const activePreset = matchPreset(rules, limits);
  function applyPreset(id: PresetId) {
    const patch = presetPatch(id);
    setRules(patch.rules); // leaves budget / per-trade / run length untouched
    setLimits(patch.limits);
  }

  /**
   * Take Kelly's "set it up for me" proposal and write it onto the visible controls
   * (style + money + mode). Nothing arms here: the plan line and the Start button below
   * are still the trader's confirm. Per-bet is kept within the budget, and the mode is
   * only changed when the trader actually named one.
   */
  function applySetup(r: ResolvedSetup) {
    const patch = presetPatch(r.preset);
    setRules(patch.rules);
    setLimits({
      ...patch.limits,
      budgetUsd: r.budgetUsd,
      perTradeUsd: Math.min(r.perTradeUsd, r.budgetUsd),
      armDurationMs: r.durationMins * 60_000,
    });
    if (r.live != null) setDryRun(!r.live);
    setCustomizeOpen(false);
  }

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-5">
      {/* ── View tabs (cockpit vs saved results) ───────────────────────────── */}
      <ViewTabs view={view} onView={setView} resultCount={history.length} running={armed} />

      {view === 'results' ? (
        <ResultsView history={history} onDelete={deleteResult} onClear={clearHistory} />
      ) : (
        <>
      {/* ── Slim sticky header: status + primary action, always reachable ──── */}
      <div className="glass-card sticky top-0 z-20 mb-4 flex items-center gap-3 p-3.5 backdrop-blur-md sm:gap-4">
        <div className="relative flex h-11 w-11 flex-none items-center justify-center sm:h-12 sm:w-12">
          <span
            aria-hidden
            className="absolute inset-0"
            style={{ background: 'radial-gradient(circle at 50% 42%, var(--accent-soft), transparent 70%)' }}
          />
          <Image src={MASCOT_SRC.thinking} alt="Kelly the fox" width={48} height={48} className="relative h-full w-full object-contain" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="eyebrow flex items-center gap-1.5">
            <LuGauge size={11} className="text-accent" /> Kelly · Autopilot
          </p>
          <div className="mt-0.5 flex items-center gap-2">
            <h1 className="text-[17px] font-semibold tracking-tight text-text-1 sm:text-[19px]">Autopilot</h1>
            <StatusPill status={status} settling={stopped && openCount > 0} />
          </div>
        </div>
        <div className="flex flex-none items-center gap-2">
          {stopped && (
            <button
              onClick={() => reset()}
              className="group glass-inset hidden items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 sm:inline-flex"
            >
              <LuTrash2 size={12} className="transition-colors duration-200 group-hover:text-accent" /> Clear log
            </button>
          )}
          {/* Start is mode-neutral: it opens the confirm, and the confirm is where
              watch-vs-live and the wallet steps happen. */}
          <div className="flex w-32 flex-col sm:w-40">
            {armed ? (
              <ReviewButton tone="down" onClick={() => disarm('manual', Date.now())}>
                Stop Autopilot
              </ReviewButton>
            ) : (
              <ReviewButton tone="up" onClick={handleStart} disabled={!canArm}>
                Start Autopilot
              </ReviewButton>
            )}
          </div>
        </div>
      </div>
      {!armed && armIssue && (
        <p className="mb-4 -mt-1 flex items-center justify-end gap-1.5 text-[10.5px] leading-tight text-text-3">
          <LuTriangleAlert size={11} className="flex-none" /> {armIssue}
        </p>
      )}

      {/* ── Stat band: live market + lifetime performance, at a glance ─────── */}
      <div className="mb-4">
        <StatBand spot={engine.spot} watching={engine.candidates.length} history={history} />
      </div>

      {/* ── Stop / reload banner (prominent, right under the header) ────────── */}
      {stopped &&
        (interruptedByReload ? (
          <ReloadBanner settlingCount={openCount} />
        ) : (
          <StoppedBanner reason={stopReason} settlingCount={openCount} />
        ))}

      {/* ── Setup (idle or stopped) ─────────────────────────────────────────
          One fork at the top, then ONE way of setting up beneath it. Both paths used to
          be on screen at once, with the manual controls filling the wide column and
          "Set it up for me" tucked third down the narrow one, which read as a footnote
          to the controls rather than an alternative to them. Whichever you are not
          using is now gone, which is the trim and the feature at the same time.
          The right column stays put in both, because the mode and the plan are the
          confirm, not the setup. */}
      {!armed && (
        <div className="mb-4 flex flex-col gap-4">
          <SetupModeTabs mode={setupMode} onMode={setSetupModeChoice} />
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <div className="flex min-w-0 flex-col gap-4">
              {setupMode === 'auto' ? (
                <KellySetupCard
                  current={{ budgetUsd: limits.budgetUsd, perTradeUsd: limits.perTradeUsd, armDurationMs: limits.armDurationMs }}
                  onApply={applySetup}
                />
              ) : (
                <>
                  <PresetPicker active={activePreset} onApply={applyPreset} />
                  <MoneyCard limits={limits} setLimits={setLimits} />
                  <CustomizeSection
                    open={customizeOpen}
                    onToggle={() => setCustomizeOpen((o) => !o)}
                    custom={activePreset === null}
                    rules={rules}
                    limits={limits}
                    setRules={setRules}
                    setLimits={setLimits}
                    toggleTenor={toggleTenor}
                    toggleSide={toggleSide}
                  />
                </>
              )}
            </div>
            {/* Sticky because it is the read-out for the controls beside it: in Manual
                the left column is much taller than this one, so a fixed plan would
                scroll away exactly while you are changing what it describes.
                `live={null}` because the mode has not been chosen yet at this point. */}
            <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
              <PlanLine rules={rules} limits={limits} live={null} presetId={activePreset} />
              <NextPick preview={engine.preview} now={now} />
              {setupMode === 'manual' && <PlanDetails rules={rules} limits={limits} />}
            </div>
          </div>
        </div>
      )}

      {/* ── Live / last-run: meters, then performance ⟷ run log ────────────── */}
      {status !== 'idle' && (
        <div className="mb-4 flex flex-col gap-4">
          <MetersStrip
            spentUsd={run.spentUsd}
            budgetUsd={limits.budgetUsd}
            tradeCount={run.tradeCount}
            maxTrades={limits.maxTrades}
            openCount={openCount}
            maxConcurrent={limits.maxConcurrent}
            armed={armed}
            timeLeftMs={timeLeftMs}
            armDurationMs={limits.armDurationMs}
          />
          {engine.positions.length > 0 || engine.perf.wins + engine.perf.losses > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <PerformancePanel perf={engine.perf} positions={engine.positions} />
              <RunLogPanel log={log} now={now} armed={armed} ready={engine.ready} />
            </div>
          ) : (
            <RunLogPanel log={log} now={now} armed={armed} ready={engine.ready} />
          )}
        </div>
      )}

      {/* ── Armed: the locked plan + the mode, AFTER the live read ──────────
          A running dashboard's primary content is what is happening now, so the meters,
          PnL and run log come first and this sits below as reference. It used to lead,
          which on a phone meant a screenful of plan before a single live number. */}
      {armed && (
        <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <PlanLine rules={rules} limits={limits} live={null} presetId={activePreset} />
          <RunningModeBanner live={live} />
        </div>
      )}

      {/* ── Footer safety note (setup only) ────────────────────────────────── */}
      {status === 'idle' && (
        <p className="flex items-start gap-1.5 text-[10.5px] leading-relaxed text-text-3">
          <LuShieldCheck size={12} className="mt-px flex-none" />
          {/* The full version of this (what the session key can and cannot do, what a
              deposit pins) now sits in the arm confirm, where it is read at the moment
              it decides something rather than skimmed at the bottom of setup. */}
          <span>Autopilot can only spend your trading-account balance, and you can stop it at any moment.</span>
        </p>
      )}

      <ArmConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        rules={rules}
        limits={limits}
        presetId={activePreset}
        live={live}
        onSetLive={(on) => setDryRun(!on)}
        fundingMode={fundingMode}
        onSetFunding={setFundingMode}
        sessionReady={sessionReady}
        sessionExpiresInMs={sessionExpiresInMs}
        onEndSession={async () => {
          await acct.endSession();
        }}
        issue={confirmIssue}
        canConfirm={canConfirm}
        arming={arming}
        onConfirm={handleArm}
        error={acct.error}
      />
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

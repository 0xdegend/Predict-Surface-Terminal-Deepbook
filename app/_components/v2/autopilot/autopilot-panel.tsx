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
import { useCallback, useEffect, useMemo, useState } from 'react';
import { LuGauge, LuHistory, LuShieldCheck, LuTrash2, LuTriangleAlert } from 'react-icons/lu';
import { ReviewButton } from '@/app/_components/ticket/review-button';
import { MASCOT_SRC } from '@/lib/mascot';
import { useNow } from '@/lib/hooks/use-now';
import { num } from '@/lib/format';
import { fromQuote, toQuote } from '@/config/scale';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import { useAutopilotEngine } from '@/lib/hooks/use-autopilot-engine';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useAutopilotStore, type RunResult } from '@/lib/store/autopilot-store';
import type { Tenor, TradeSide } from '@/lib/autopilot/policy';
import { type PresetId, matchPreset, presetPatch } from '@/lib/autopilot/presets';
import type { ResolvedSetup } from '@/lib/autopilot/setup-parser';
import { topUpBase } from '@/lib/autopilot/funding';
import { buildRunTape } from '@/lib/autopilot/run-tape';
import { type SetupMode, type StartOutcome } from './shared';
import { CustomizeSection, MoneyCard, PlanDetails, PresetPicker, SetupModeTabs } from './setup';
import { PlanCard } from './plan-card';
import { KellySetupCard } from './kelly-setup-card';
import { ArmConfirmModal } from './arm-confirm';
import { HeaderTape, MetersStrip, PausedBanner, PerformancePanel, ReloadBanner, RunLogPanel, RunModePill, StatBand, StatusPill, StoppedBanner } from './live';
import { SessionGasModal } from '@/app/_components/session-gas-modal';
import { ResultsView } from './results';
import { SessionShareModal } from './session-share-modal';

interface Props {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
}

/**
 * A finished run clears itself, in two beats.
 *
 * First a quiet pause, so the last thing a trader sees when a run ends is the run and not
 * a countdown. Then a visible countdown, because a dashboard that empties itself with no
 * warning reads as a bug. Fifteen seconds in total, and the header's "Clear log" button
 * still does it immediately for anyone who has already read enough.
 *
 * Nothing is lost when it goes: the run is in Results by then, with every trade and its
 * digest. Only the rolling log itself is dropped.
 */
const CLEAR_QUIET_MS = 5_000;
const CLEAR_COUNTDOWN_MS = 10_000;

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
  const pauseReason = useAutopilotStore((s) => s.pauseReason);
  const stoppedAt = useAutopilotStore((s) => s.stoppedAt);
  const interruptedByReload = useAutopilotStore((s) => s.interruptedByReload);
  const log = useAutopilotStore((s) => s.log);
  const setRules = useAutopilotStore((s) => s.setRules);
  const setLimits = useAutopilotStore((s) => s.setLimits);
  const setDryRun = useAutopilotStore((s) => s.setDryRun);
  const arm = useAutopilotStore((s) => s.arm);
  const disarm = useAutopilotStore((s) => s.disarm);
  const history = useAutopilotStore((s) => s.history);
  const deleteResult = useAutopilotStore((s) => s.deleteResult);
  const clearHistory = useAutopilotStore((s) => s.clearHistory);

  const [arming, setArming] = useState(false);
  const [view, setView] = useState<'cockpit' | 'results'>('cockpit');
  const [customizeOpen, setCustomizeOpen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false); // arm-time confirm (live only)
  // The session-gas top-up, opened from the pause banner. The run resumes on its own
  // once the engine reads the key as funded again; nothing here has to tell it.
  const [gasOpen, setGasOpen] = useState(false);
  // Auto (tell Kelly) vs Manual (set the controls yourself). Auto is the landing tab for
  // everyone, not just first-timers: describing a run in a sentence is the shorter path
  // even when you already know the controls, and Manual is one tap away. This used to
  // resolve off `history` (Auto for a first run, Manual once you had a track record),
  // which meant the people most able to judge the feature stopped being shown it.
  const [setupMode, setSetupMode] = useState<SetupMode>('auto');
  /**
   * The run being offered as a share card, and where the offer came from. `finished`
   * is the dialog opening itself the moment a run's log clears with every trade
   * settled; `results` is the trader asking for it from the archive.
   */
  const [share, setShare] = useState<{ run: RunResult; context: 'finished' | 'results' } | null>(null);

  // Load the persisted run + results after mount (see skipHydration in the store): a
  // reload restores an in-progress run's open trades, and _resumeAfterReload lands it
  // stopped so it never resumes placing trades on its own.
  useEffect(() => {
    void useAutopilotStore.persist.rehydrate();
  }, []);

  /**
   * Clear a finished run on its own, so nobody has to press "Clear log" to get their setup
   * screen back.
   *
   * Gated on `run.open.length`, NOT on `openCount`: openCount drops a position the moment
   * its expiry passes, but the engine keeps holding it until it can read the on-chain
   * settlement and score it. Resetting in that window would throw away a win or a loss,
   * because recordSettlement only folds a result into the archive while the run is still
   * `stopped`. Waiting for the tracked list to empty means the archive is complete first.
   *
   * The arm confirm holds it off too, so the banner it is sitting on top of does not
   * disappear underneath the dialog.
   */
  const trackedOpen = run.open.length;
  // Every stopped run clears, including one a reload stopped: `_resumeAfterReload` logs
  // that as an event, so the deadline below is measured from the reload rather than from
  // whatever last happened before it. It has to clear, now that a stopped run holds the
  // page: without this there would be no way back to setup but the button, which is not
  // on screen at phone widths.
  const finished = status === 'stopped' && trackedOpen === 0 && !arming && !confirmOpen;
  /**
   * WHEN it became fully done, derived rather than remembered: the newest log line IS that
   * moment, either the disarm itself or the settlement that emptied the last position. So
   * there is no effect holding a timestamp, no second interval for the count (the panel
   * already re-renders every second off `now`), and a deadline instead of a tick means a
   * backgrounded tab catches up on return rather than stalling part-way down.
   */
  const clearAt = finished && log[0] ? log[0].at + CLEAR_QUIET_MS + CLEAR_COUNTDOWN_MS : null;
  /**
   * Clear the run, and when it is completely done, offer it as a card.
   *
   * "Completely done" is stricter than "stopped": every trade it placed has settled
   * (the tracked list is empty), so the saved result the card paints is the whole
   * story and not a snapshot with pending rows. A run that a reload stopped is left
   * out too: the trader is arriving, not finishing, and a dialog over the landing is
   * the wrong first thing to see. Read off the store rather than the render, because
   * the auto-clear fires from a timeout. The log is dropped either way, exactly as
   * before; nothing about the archive changes.
   */
  const finishRun = useCallback(() => {
    const st = useAutopilotStore.getState();
    const result = st.history.find((r) => r.id === st.run.id) ?? null;
    const complete = st.status === 'stopped' && st.run.open.length === 0 && !st.interruptedByReload;
    st.reset();
    if (result && complete) setShare({ run: result, context: 'finished' });
  }, []);
  useEffect(() => {
    if (clearAt == null) return;
    const t = setTimeout(finishRun, Math.max(0, clearAt - Date.now()));
    return () => clearTimeout(t);
  }, [clearAt, finishRun]);
  // Null through the quiet pause, then counts the last ten seconds out loud.
  const msToClear = clearAt != null ? clearAt - now : null;
  const clearInSec =
    msToClear != null && msToClear <= CLEAR_COUNTDOWN_MS ? Math.max(0, Math.ceil(msToClear / 1000)) : null;

  const armed = status === 'armed';
  const paused = status === 'paused';
  /** Armed or holding for gas: the run is still on, its clock still counts, and the
   *  header offers Stop rather than Start. Only `armed` actually places trades. */
  const running = armed || paused;
  const stopped = status === 'stopped';
  /**
   * Setup, or a run. Never both.
   *
   * The page used to fork on `armed`, so the moment a run stopped it dropped the setup
   * screen back in ABOVE the run: a trade could still be open, still moving, and the
   * meters and log watching it slid down the page under a fresh "how do you want to play
   * it". A run that has stopped placing trades has not finished, and it stays where it
   * was until its log clears, automatically or by the button. That is also one reflow
   * instead of two, since the run does not move down and then vanish fifteen seconds
   * later.
   */
  const idle = status === 'idle';
  const live = !dryRun; // "live trading" vs "watch mode"
  const timeLeftMs = running ? Math.max(0, limits.armDurationMs - (now - run.armedAt)) : limits.armDurationMs;
  // Capped at the configured length so a run that overran by a second does not read past
  // its own limit, and floored at 0 for the idle state where there is no run to measure.
  const ranForMs =
    stoppedAt != null ? Math.min(limits.armDurationMs, Math.max(0, stoppedAt - run.armedAt)) : 0;
  const openCount = useMemo(() => run.open.filter((p) => p.expiry > now).length, [run.open, now]);
  /**
   * The run as a timeline, for the tape above the log.
   *
   * Deliberately free of `now`: the axis is the run's own clock, and the playhead is the
   * component's business, so this only rebuilds when the run actually changes rather than
   * once a second alongside the rest of the page.
   */
  const tape = useMemo(
    () =>
      buildRunTape({
        armedAt: run.armedAt,
        armDurationMs: limits.armDurationMs,
        open: run.open,
        settled: run.settled,
        log,
      }),
    [run.armedAt, run.open, run.settled, limits.armDurationMs, log],
  );
  /**
   * Arming, as a moment.
   *
   * Pressing Start hands a bot real money and then puts a screen full of zeroes on the
   * page, and until now that screen simply appeared, fully formed and completely still.
   * The block below keys on the run id so it remounts on every arm (including re-arming
   * straight from a stopped run, where nothing else would have changed), and wears the
   * sequence class only for the first couple of seconds, so a tab left open for an hour
   * is not carrying an animation it finished long ago. The whole thing lives in CSS and
   * skips entirely under `prefers-reduced-motion`.
   */
  const justArmed = status === 'armed' && now - run.armedAt < 2_000;

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
  // How much has to move in from the wallet before the run can cover its budget. This
  // used to be a question ("deposit, or use the account balance?") on a screen where the
  // trader is one tap from spending money, and it had exactly one right answer every
  // time: top up if you are short, otherwise do not. So it is arithmetic now, and the
  // confirm shows the balance instead of asking.
  const topUp = live ? topUpBase(toQuote(limits.budgetUsd), acct.balanceBase) : 0n;
  // Kept separate from armIssue because the mode itself is chosen inside the confirm:
  // folding a live-only blocker into the Start button would lock you out of the screen
  // where you could have picked Watch instead.
  const fundingIssue =
    live && topUp > 0n && (acct.walletDusdcBase ?? 0n) < topUp
      ? `Your wallet needs $${num(fromQuote(topUp), 2)} of DUSDC to top the run up to $${num(limits.budgetUsd, 0)}`
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
   * Arm the run. Watch mode arms immediately. Live mode first turns on the session key,
   * moving in only the shortfall between the trading account and the run's budget: the
   * session spends the account balance, so topping it up to the budget is all the run
   * ever needs. A full account tops up nothing, and when a session is already live that
   * means no signature at all. Only once the session is authorized does the run arm.
   */
  /** Open the confirm. Watch and live both route through it: the mode is picked there. */
  function handleStart() {
    setConfirmOpen(true);
  }

  /** Resolves true once the run is armed; false when a wallet step failed or was cancelled. */
  async function handleArm(): Promise<boolean> {
    if (!live) {
      // Watch spends nothing, so it arms straight from the confirm with no wallet step.
      // The close has to happen on THIS path too: an early return here is what left the
      // dialog sitting open over a running dashboard.
      arm(Date.now());
      setConfirmOpen(false);
      return true;
    }
    if (!acct.sessionsEnabled || !acct.owner || !acct.wrapperExists) return false;
    setArming(true);
    try {
      // Recomputed here rather than read off the render, so the amount signed for is
      // the shortfall at the moment of signing.
      const deposit = topUpBase(toQuote(limits.budgetUsd), acct.balanceBase);
      if (deposit > 0n || !acct.sessionCanTrade) {
        const digest = await acct.startSession({ budgetBase: deposit, duration: '24h' });
        if (!digest) return false; // cancelled or failed — acct.error explains why
      }
      arm(Date.now());
      setConfirmOpen(false);
      return true;
    } finally {
      setArming(false);
    }
  }

  /**
   * Start straight from Kelly's chat.
   *
   * Saying "start" used to open the same confirm as the button, so the shortest path to
   * a run was: describe it, say start, then read a dialog and press Start again. The
   * dialog exists for two decisions, the mode and the money. By the time the chat is
   * done the mode is already on record (say "live" or "watch"; it is remembered), so the
   * only thing left that is genuinely the trader's is money moving in, and that is the
   * one case that still opens it. A live blocker no word in the chat can clear (no
   * wallet, no trading account, sessions off) opens it too, because the way past those,
   * connecting or switching to watch, lives there. Everything else arms on the spot.
   * Instant trading that needs (re)approving is the wallet's own prompt, not ours.
   */
  function quickStart(): StartOutcome {
    if (!live) {
      arm(Date.now());
      return { kind: 'started', live: false };
    }
    if (liveSetupIssue) {
      setConfirmOpen(true);
      return { kind: 'confirm', why: 'blocked', issue: liveSetupIssue };
    }
    if (topUp > 0n) {
      setConfirmOpen(true);
      return { kind: 'confirm', why: 'top_up', topUpUsd: fromQuote(topUp), budgetUsd: limits.budgetUsd };
    }
    if (acct.sessionCanTrade) {
      arm(Date.now());
      return { kind: 'started', live: true };
    }
    return { kind: 'signing', done: handleArm() };
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
      {/* ── One command bar ─────────────────────────────────────────────────
          This was three stacked full-width strips before a single piece of content: a
          view switcher, a header card, and the Auto/Manual fork. 308px of chrome on a
          1200px screen, carrying the word "Autopilot" five times (the tab, the eyebrow,
          the title) and 778px of nothing between the title and the button.

          One bar now, one title, and the void holds the live tape, which is the only
          thing on this page that moves while nothing is running. The fork moved down to
          sit above the column it actually switches. */}
      <div className="glass-card sticky top-0 z-20 mb-4 flex flex-wrap items-center gap-x-4 gap-y-2.5 p-3 backdrop-blur-md sm:gap-x-5 sm:p-3.5">
        <div className="relative flex h-10 w-10 flex-none items-center justify-center">
          <span
            aria-hidden
            className="absolute inset-0"
            style={{ background: 'radial-gradient(circle at 50% 42%, var(--accent-soft), transparent 70%)' }}
          />
          <Image src={MASCOT_SRC.thinking} alt="Kelly the fox" width={40} height={40} className="relative h-full w-full object-contain" />
        </div>
        <div className="flex flex-none items-center gap-2">
          <h1 className="text-[17px] font-semibold tracking-tight text-text-1 sm:text-[18px]">Autopilot</h1>
          <StatusPill key={`${status}:${stopped && openCount > 0}`} status={status} settling={stopped && openCount > 0} />
          {running && <RunModePill live={live} />}
        </div>

        <HeaderTape spot={engine.spot} watching={engine.candidates.length} />

        {/* On a phone this wraps to its own line, so it spreads rather than hugging the
            right edge and leaving 340px of empty bar beside it. From `sm` it goes back to
            sitting at the end of the row. */}
        <div className="flex w-full flex-none items-center justify-between gap-2 sm:ml-auto sm:w-auto sm:justify-end">
          <ViewSwitch view={view} onView={setView} resultCount={history.length} running={running} />
          {stopped && (
            <button
              onClick={finishRun}
              className="group glass-inset hidden items-center gap-1.5 px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 sm:inline-flex"
            >
              <LuTrash2 size={12} className="transition-colors duration-200 group-hover:text-accent" /> Clear log
            </button>
          )}
          {/* Start is mode-neutral: it opens the confirm, and the confirm is where
              watch-vs-live and the wallet steps happen. */}
          <div className="flex w-32 flex-col sm:w-36">
            {running ? (
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

      {view === 'results' ? (
        <ResultsView
          history={history}
          onDelete={deleteResult}
          onClear={clearHistory}
          onShare={(r) => setShare({ run: r, context: 'results' })}
        />
      ) : (
        <>
      {idle && armIssue && (
        <p className="mb-4 -mt-1 flex items-center justify-end gap-1.5 text-[10.5px] leading-tight text-text-3">
          <LuTriangleAlert size={11} className="flex-none" /> {armIssue}
        </p>
      )}

      {/* ── Stat band: live market + lifetime performance, at a glance ───────
          Top of the page while nothing is running. During a run it moves BELOW the live
          blocks (see the armed section): stacking it over the meters put two identical
          rows of four tiles in a row, so the trader's own record competed with the
          numbers that change every second. Ordered by what you are actually watching. */}
      {idle && (
        <div className="mb-4">
          <StatBand spot={engine.spot} watching={engine.candidates.length} history={history} />
        </div>
      )}

      {/* ── Stop / reload banner (prominent, right under the header) ────────── */}
      {stopped &&
        (interruptedByReload ? (
          <ReloadBanner settlingCount={openCount} />
        ) : (
          <StoppedBanner reason={stopReason} settlingCount={openCount} clearInSec={clearInSec} />
        ))}
      {/* ── Hold banner: low gas pauses the run rather than ending it ─────────
          The top-up opens the same modal the wallet menu uses; the engine resumes the
          run on its own once it reads the key as funded. */}
      {paused && (
        <PausedBanner
          reason={pauseReason}
          settlingCount={openCount}
          onTopUp={() => setGasOpen(true)}
          onStop={() => disarm('manual', Date.now())}
        />
      )}

      {/* ── Setup (idle or stopped) ─────────────────────────────────────────
          One fork at the top, then ONE way of setting up beneath it. Both paths used to
          be on screen at once, with the manual controls filling the wide column and
          "Set it up for me" tucked third down the narrow one, which read as a footnote
          to the controls rather than an alternative to them. Whichever you are not
          using is now gone, which is the trim and the feature at the same time.
          The right column stays put in both, because the mode and the plan are the
          confirm, not the setup. */}
      {idle && (
        <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            {/* The fork sits above the column it switches, at its own width, instead of
                spanning both columns as a third full-width bar. It governs the left side
                only: the plan on the right is the same read-out either way. */}
            <div className="flex min-w-0 flex-col gap-4">
              <SetupModeTabs mode={setupMode} onMode={setSetupMode} />
              {setupMode === 'auto' ? (
                <KellySetupCard
                  current={{ budgetUsd: limits.budgetUsd, perTradeUsd: limits.perTradeUsd, armDurationMs: limits.armDurationMs }}
                  onApply={applySetup}
                  onStart={quickStart}
                  startIssue={armIssue}
                  live={live}
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
                In Auto the mode is what "start" will use, so it is shown; in Manual it is
                `null` because the Start button's confirm is where it gets chosen. */}
            <div className="flex min-w-0 flex-col gap-4 lg:sticky lg:top-24 lg:self-start">
              <PlanCard rules={rules} limits={limits} live={setupMode === 'auto' ? live : null} presetId={activePreset} />
              {setupMode === 'manual' && <PlanDetails rules={rules} limits={limits} />}
            </div>
        </div>
      )}

      {/* ── Live / last-run: meters, performance ⟷ run log, the locked plan ──
          ONE block, in the order a running dashboard is read: what the run has spent and
          how long it has left, then how it is doing and what it just did, then the plan
          it is following and the record it is adding to. These were two sibling blocks
          with the same condition, which meant the arming sequence could only ever reach
          half of them.

          The plan is `compact` here, not the four-row stepper. The stepper teaches a plan
          you are still deciding on; once a run is live the plan is a locked read-out, and
          at full height it was a 440px card sharing a row with a one-line mode banner. The
          strip says the same thing, full width, in about a third of the space. */}
      {!idle && (
        <div key={run.id} className={`mb-4 flex flex-col gap-4 ${justArmed ? 'arm-in' : ''}`}>
          <MetersStrip
            spentUsd={run.spentUsd}
            budgetUsd={limits.budgetUsd}
            tradeCount={run.tradeCount}
            maxTrades={limits.maxTrades}
            openCount={openCount}
            maxConcurrent={limits.maxConcurrent}
            armed={running}
            timeLeftMs={timeLeftMs}
            ranForMs={ranForMs}
            armDurationMs={limits.armDurationMs}
          />
          {engine.positions.length > 0 || engine.perf.wins + engine.perf.losses > 0 ? (
            <div className="grid gap-4 lg:grid-cols-2">
              <PerformancePanel perf={engine.perf} positions={engine.positions} />
              <RunLogPanel log={log} tape={tape} now={now} armed={armed} paused={paused} ready={engine.ready} />
            </div>
          ) : (
            <RunLogPanel log={log} tape={tape} now={now} armed={armed} paused={paused} ready={engine.ready} />
          )}
          <PlanCard
            rules={rules}
            limits={limits}
            live={null}
            presetId={activePreset}
            avatar={false}
            variant="compact"
            surface="card"
          />
          <StatBand spot={engine.spot} watching={engine.candidates.length} history={history} />
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
        balanceUsd={fromQuote(acct.balanceBase)}
        topUpUsd={fromQuote(topUp)}
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

      {/* The finished run as a card to post. Mounted outside the view fork so it can
          open over either screen: the setup it just cleared back to, or Results. */}
      <SessionShareModal run={share?.run ?? null} context={share?.context ?? 'results'} onClose={() => setShare(null)} />
      {/* Session-gas top-up for a paused run. Same dialog as the wallet menu's, so the
          free (Google) and fund-from-wallet (Slush) paths both work from here. */}
      <SessionGasModal open={gasOpen} onClose={() => setGasOpen(false)} />
    </div>
  );
}

/* ------------------------------- pieces ---------------------------------- */

/**
 * The view switch, as a control inside the command bar rather than a full-width strip
 * above it. Labels collapse to icons below `sm`, where the bar is already carrying the
 * title, the status and the primary action.
 *
 * "Run", not "Autopilot": the bar's own `h1` two controls to the left already says
 * Autopilot, and the tab saying it again was one of the five on the page.
 */
function ViewSwitch({
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
    <div className="flex flex-none items-center gap-0.5 rounded-lg bg-white/4 p-0.5">
      <ViewTab active={view === 'cockpit'} onClick={() => onView('cockpit')}>
        <LuGauge size={13} className="flex-none" />
        <span className="hidden sm:inline">Run</span>
        {running && (
          <span className="relative flex h-1.5 w-1.5 flex-none">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-up opacity-75" />
            <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-up" />
          </span>
        )}
      </ViewTab>
      <ViewTab active={view === 'results'} onClick={() => onView('results')}>
        <LuHistory size={13} className="flex-none" />
        <span className="hidden sm:inline">Results</span>
        {resultCount > 0 && (
          <span className="rounded-full bg-white/8 px-1.5 py-px font-mono text-[10px] tabular-nums text-text-2">
            {resultCount}
          </span>
        )}
      </ViewTab>
    </div>
  );
}

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-[12px] font-medium transition-all duration-150 sm:px-3 ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-3 hover:text-text-1'
      }`}
    >
      {children}
    </button>
  );
}

/* -------------------------------- results -------------------------------- */

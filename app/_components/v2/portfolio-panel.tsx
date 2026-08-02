'use client';

/**
 * V2PortfolioPanel — the trader's account home on the NEW deployment, in the
 * exact visual language of the legacy portfolio: the frosted account bento
 * (value hero, PnL, exposure, balances), a Ready-to-redeem strip, and the
 * Positions / History segmented tabs with glass position cards.
 *
 * Balances (trading account, wallet, vault shares) are live on-chain reads.
 * Positions and history come from the v2 indexer's owner-scoped endpoints. A
 * connected account with none sees the real empty state ("No open positions
 * yet"), not filler. Clearly-marked SAMPLE rows (lib/portfolio/v2.ts) are an
 * opt-in design scaffold, gated behind V2_DEMO_ENABLED (off by default).
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import { GlassError } from '../ui/glass-error';
import Link from 'next/link';
import type { IconType } from 'react-icons';
import {
  LuWallet,
  LuWalletMinimal,
  LuTrendingUp,
  LuTrendingDown,
  LuLayers,
  LuCoins,
  LuDownload,
  LuUpload,
  LuHistory,
  LuArrowRight,
  LuFlaskConical,
  LuVault,
  LuLayoutGrid,
  LuRows3,
} from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote, signed, pct, shortId } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { InfoTip } from '../ui/info-tip';
import { Modal } from '../ui/modal';
import { SuccessModal } from '../ui/success-modal';
import { Skel } from '@/app/_components/page-skeletons';
import { ConnectGate } from '../positions/connect-gate';
import { PerformanceCard } from '../positions/performance-card';
import { PerfShareCardModal } from '../positions/perf-share-card-modal';
import { HistoryTable } from '../positions/history-table';
import { derivePortfolioHistory, equityCurve } from '@/lib/portfolio/history';
import {
  V2_DEMO_ENABLED,
  demoPositions,
  demoHistory,
  winningClaimPayout,
  type V2PortfolioPosition,
} from '@/lib/portfolio/v2';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { useV2History } from '@/lib/hooks/use-v2-history';
import { V2PositionCard } from './position-card';
import { V2PositionRow } from './position-row';
import { V2RedeemModal } from './redeem-modal';
import { useClaimCelebration } from './use-claim-celebration';

type FundMode = 'add' | 'withdraw';

/** Position layout preference (persisted). The claimable strip and the open-
 *  positions list each keep their OWN preference, so switching one never flips
 *  the other. */
type PosView = 'grid' | 'compact';
const POS_VIEW_KEY = 'v2:positions-view';
const REDEEM_VIEW_KEY = 'v2:redeem-view';

/** A grid/compact preference persisted to localStorage under `key`. */
function usePersistedView(key: string): [PosView, (v: PosView) => void] {
  const [view, setView] = useState<PosView>('compact');
  useEffect(() => {
    // Read the saved preference AFTER mount (not in the initializer) so SSR and
    // the first client render agree on the default — no hydration mismatch.
    try {
      const v = localStorage.getItem(key);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot sync from localStorage
      if (v === 'grid' || v === 'compact') setView(v);
    } catch {
      /* private mode / no storage — keep the default */
    }
  }, [key]);
  const change = (v: PosView) => {
    setView(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      /* ignore */
    }
  };
  return [view, change];
}

export function V2PortfolioPanel({ serverNow }: { serverNow: number }) {
  const acct = usePredictAccountV2();
  const mounted = useMounted();
  const now = useNow(serverNow);
  // Enriched real positions + the market map (shared with the trade-rail panel so
  // the two never drift). Sample rows + history stay local to this panel.
  const { positions: real, isLoading: positionsLoading, marketMap } = useV2PortfolioPositions(
    acct.accountId,
    acct.owner,
  );

  const [tab, setTab] = useState<'positions' | 'history'>('positions');
  const [fundMode, setFundMode] = useState<FundMode | null>(null);
  const [fundDone, setFundDone] = useState<{ mode: FundMode; amount: number; digest: string } | null>(null);
  // Close/redeem runs through a confirmation dialog (win/loss + partial close),
  // mirroring the legacy flow — never a one-shot instant tx.
  const [redeeming, setRedeeming] = useState<V2PortfolioPosition | null>(null);
  // Winning claims get a celebration (SuccessModal + confetti) instead of a toast.
  const { celebrate, overlay: claimCelebration } = useClaimCelebration();
  // Share-as-image dialog for the settled track record (win rate) — legacy parity.
  const [shareOpen, setShareOpen] = useState(false);
  // Position layout: dense rows (default — claimable winners never dominate the
  // page) or the full cards. The claimable strip and the open-positions list each
  // remember their OWN choice, so switching one doesn't flip the other.
  const [redeemView, changeRedeemView] = usePersistedView(REDEEM_VIEW_KEY);
  const [posView, changePosView] = usePersistedView(POS_VIEW_KEY);

  const demoActive = V2_DEMO_ENABLED && !positionsLoading && real.length === 0;

  // Sample rows are anchored to the page-load clock so countdowns tick down
  // against `now` instead of being recomputed each second.
  const rows = useMemo(
    () => (demoActive ? demoPositions(serverNow) : real),
    [demoActive, serverNow, real],
  );

  // Real trade history from the order event log (authoritative). Sample rows
  // fill the tab only while the account has no real positions at all.
  const { history: realHistory, isLoading: historyLoading } = useV2History(
    acct.accountId,
    marketMap,
    acct.owner,
  );
  const { history, stats } = useMemo(
    () => derivePortfolioHistory([], demoActive ? demoHistory(serverNow) : realHistory),
    [demoActive, serverNow, realHistory],
  );
  const curve = useMemo(() => equityCurve(history), [history]);

  if (!mounted) {
    return (
      <Centered>
        <p className="text-[12px] text-text-3">Loading account…</p>
      </Centered>
    );
  }

  if (!acct.owner) {
    return <ConnectGate />;
  }

  if (acct.isLoading) {
    return (
      <Centered>
        <p className="text-[12px] text-text-3">Loading account…</p>
      </Centered>
    );
  }

  if (!acct.wrapperExists) {
    return <CreateAccountCard busy={acct.busy === 'create'} onCreate={() => acct.createAccount()} />;
  }

  const live = rows.filter((p) => !p.settled && p.qty > 0);
  const redeemable = rows.filter((p) => p.settled && p.qty > 0 && p.won !== false);
  // Settled losers still hold quantity until cleared — show them (with a plain
  // "Lost" verdict + Clear action) rather than dropping them silently, so the
  // trader can always tell whether a bet won or lost. They carry no unrealized
  // value, so they stay out of the money math below.
  const settledLost = rows.filter((p) => p.settled && p.qty > 0 && p.won === false);
  const open = [...live, ...settledLost];

  const freeBalance = fromQuote(acct.balanceBase);
  const openValue = live.reduce((s, p) => s + (p.markValue ?? p.cost ?? 0), 0);
  const claimValue = redeemable.reduce((s, p) => s + (p.markValue ?? 0), 0);
  const accountValue = freeBalance + openValue + claimValue;
  const openExposure = live.reduce((s, p) => s + (p.cost ?? 0), 0);
  const unrealized = live.reduce((s, p) => s + (p.pnl ?? 0), 0);
  const unrealizedPct = openExposure > 0 ? unrealized / openExposure : 0;
  // Settled but not yet redeemed — the result is decided (won → +payout − cost,
  // lost → −cost) even though the trader hasn't claimed/cleared it. Counting it
  // keeps Total PnL continuous through settlement: a winning bet's gain carries
  // straight over from unrealized instead of vanishing until it's claimed. No
  // double-count — once redeemed a position leaves this list and lands in the
  // realized history below.
  const settledPnl = [...redeemable, ...settledLost].reduce((s, p) => s + (p.pnl ?? 0), 0);
  const totalPnl = unrealized + settledPnl + stats.realizedPnl;

  // Confirmed from the dialog with the chosen partial amount (base units). A
  // close < full leaves the remainder open to close later; equal-to-open closes
  // the whole lot. The chain confirms the exact quantity on sign.
  async function handleRedeemConfirm(p: V2PortfolioPosition, closeQuantity: bigint) {
    if (p.sample || !p.marketId || p.orderId == null || closeQuantity <= 0n) {
      setRedeeming(null);
      return;
    }
    const args = { marketId: p.marketId, orderId: p.orderId, closeQuantity };
    // A settled winner is a celebration, not a toast: claim it silently, then pop
    // the SuccessModal + confetti with the payout. Live closes / worthless clears
    // keep the quiet toast (winningClaimPayout returns null for them).
    const payout = winningClaimPayout(p, closeQuantity);
    const digest = p.settled
      ? await acct.redeemSettled(args, payout != null ? { silentSuccess: true } : undefined)
      : await acct.redeemLive(args);
    // Keep the dialog open on failure (error surfaces in the panel); close it once
    // the tx lands so the refreshed position list takes over.
    if (digest) {
      setRedeeming(null);
      if (payout != null) celebrate(payout, digest);
    }
  }

  async function handleFund(amount: number) {
    if (!fundMode) return;
    const digest =
      fundMode === 'add' ? await acct.deposit(toQuote(amount)) : await acct.withdraw(toQuote(amount));
    setFundMode(null);
    if (digest) setFundDone({ mode: fundMode, amount, digest });
  }

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5">
      {/* Sample-data notice — shown only while the indexer has nothing to report. */}
      {demoActive && (
        <div className="glass-inset mb-4 flex items-center gap-3 px-4 py-3">
          <IconChip icon={LuFlaskConical} color={HUE.amber} size={26} />
          <p className="text-[11.5px] leading-relaxed text-text-2">
            <span className="font-medium text-text-1">You&apos;re viewing sample data.</span>{' '}
            Your balances are live, but the positions, PnL and history shown are illustrative —
            they switch to your real figures the moment the new deployment&apos;s data feed comes
            online.
          </p>
        </div>
      )}

      {/* Account header — bento: a balanced grid of stat cards */}
      <div className="glass-card mb-6 grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums lg:grid-cols-3">
        {/* Account value — hero (emphasized by its larger number + accent wash) */}
        <div className="glass-inset relative col-span-2 flex flex-col gap-3 overflow-hidden p-4 lg:col-span-1">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 90% at 0% 0%, var(--accent-soft), transparent 60%)' }}
          />
          <div className="relative flex items-center gap-2.5">
            <IconChip icon={LuWallet} color={HUE.teal} size={30} />
            <span className="eyebrow">Account value</span>
          </div>
          <div className="relative flex flex-col gap-2">
            <span className="text-[34px] leading-none tracking-tight text-text-1">
              {fmtQuote(accountValue)}
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">
              {predictV2Config.quote.symbol} · {predictV2Config.network}
            </span>
          </div>
        </div>

        <SmallStat
          icon={totalPnl >= 0 ? LuTrendingUp : LuTrendingDown}
          color={totalPnl >= 0 ? HUE.teal : HUE.coral}
          label="Total PnL"
          info="Your all-in profit or loss: open bets marked to their current value, settled bets waiting to be claimed, and everything you've already closed."
          value={signed(totalPnl)}
          tone={totalPnl >= 0 ? 'up' : 'down'}
        />
        <SmallStat
          icon={LuLayers}
          color={HUE.blue}
          label="Open exposure"
          info="Money currently staked in open bets — it comes back (plus or minus the result) when they close or settle."
          value={fmtQuote(openExposure)}
        />
        <SmallStat
          icon={LuCoins}
          color={HUE.amber}
          label="Trading account balance"
          info="Money in your trading account that isn't tied up in open bets — free to place new bets or move back to your wallet anytime."
          value={fmtQuote(freeBalance)}
          action={
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              <button
                onClick={() => setFundMode('add')}
                disabled={!!acct.busy}
                className="group glass-inset inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-1 transition-all duration-200 hover:border-(--accent-line) hover:text-accent disabled:opacity-50"
              >
                <LuUpload size={12} className="transition-colors duration-200 group-hover:text-accent" />
                {acct.busy === 'deposit' ? 'adding…' : 'Add funds'}
              </button>
              {acct.balanceBase > 0n && (
                <button
                  onClick={() => setFundMode('withdraw')}
                  disabled={!!acct.busy}
                  className="group glass-inset inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-1 transition-all duration-200 hover:border-(--accent-line) hover:text-accent disabled:opacity-50"
                >
                  <LuDownload size={12} className="transition-colors duration-200 group-hover:text-accent" />
                  {acct.busy === 'withdraw' ? 'withdrawing…' : 'Withdraw'}
                </button>
              )}
            </div>
          }
        />
        <SmallStat
          icon={LuWalletMinimal}
          color={HUE.violet}
          label="Wallet DUSDC"
          value={acct.walletDusdcBase === undefined ? '…' : fmtQuote(fromQuote(acct.walletDusdcBase))}
        />

        {/* Vault shares — the feature stat balancing the grid's bottom-right */}
        <div className="glass-inset relative col-span-2 flex flex-col gap-2 overflow-hidden p-4 lg:col-span-1">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 90% at 100% 0%, var(--accent-soft), transparent 60%)' }}
          />
          <div className="relative flex items-center gap-2">
            <IconChip icon={LuVault} color={HUE.teal} size={22} />
            <span className="eyebrow">Vault shares</span>
          </div>
          <span className="relative text-[20px] leading-none tracking-tight text-accent">
            {fmtQuote(fromQuote(acct.plpBalanceBase))} <span className="text-[11px] text-text-3">PLP</span>
          </span>
          <span className="relative text-[10px] leading-relaxed text-text-3">
            Your share of the market-making vault —{' '}
            <Link href="/v2/vault" className="underline underline-offset-2 hover:text-text-2">
              manage in Vault
            </Link>
          </span>
        </div>
      </div>

      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} className="mb-4" />}

      {/* Ready to redeem (settled) — ALWAYS visible; it's claimable money and
          should never sit behind a tab. */}
      {redeemable.length > 0 && (
        <Section
          title="Ready to redeem"
          hint={`${fmtQuote(claimValue)} ${predictV2Config.quote.symbol} to claim`}
          action={<ViewToggle view={redeemView} onChange={changeRedeemView} />}
        >
          <PositionList view={redeemView} positions={redeemable} now={now} busy={!!acct.busy} onRedeem={setRedeeming} />
        </Section>
      )}

      {/* Positions / History — the two long sections, tabbed to keep the page short. */}
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="segmented w-[240px]" role="tablist" aria-label="Portfolio sections">
          <span
            aria-hidden
            className="segmented-thumb"
            style={{ transform: tab === 'history' ? 'translateX(100%)' : 'translateX(0)' }}
          />
          <TabButton icon={LuLayers} label="Positions" active={tab === 'positions'} onClick={() => setTab('positions')} />
          <TabButton icon={LuHistory} label="History" active={tab === 'history'} onClick={() => setTab('history')} />
        </div>
        {tab === 'positions' && open.length > 0 && (
          <div className="flex items-center gap-3">
            {live.length > 0 && (
              <span className={`font-mono text-[11px] tabular-nums ${unrealized >= 0 ? 'text-up' : 'text-down'}`}>
                {signed(unrealized)} unrealized ({signed(unrealizedPct * 100, 1)}%)
              </span>
            )}
            <ViewToggle view={posView} onChange={changePosView} />
          </div>
        )}
        {tab === 'history' && stats.total > 0 && (
          <span className={`font-mono text-[11px] tabular-nums ${stats.realizedPnl >= 0 ? 'text-up' : 'text-down'}`}>
            {signed(stats.realizedPnl)} realized · {pct(stats.winRate, 0)} win
          </span>
        )}
      </div>

      {tab === 'positions' ? (
        open.length === 0 ? (
          <EmptyState
            icon={LuLayers}
            color={HUE.teal}
            title="No open positions yet"
            description="Pick a market and mint an UP / DOWN contract — your live bets and their PnL land here."
            action={
              <Link
                href="/v2"
                className="inline-flex items-center gap-1.5 rounded-lg border border-(--accent-line) bg-(--accent-soft) px-3.5 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15"
              >
                Open the markets
                <LuArrowRight size={14} />
              </Link>
            }
          />
        ) : (
          <PositionList view={posView} positions={open} now={now} busy={!!acct.busy} onRedeem={setRedeeming} />
        )
      ) : historyLoading && !demoActive && stats.total === 0 ? (
        // First load of the order log (the owner tx-sender read takes a beat) —
        // show the section's real shape, not a flash of the "no trades" empty state.
        <HistorySkeleton />
      ) : stats.total === 0 ? (
        <EmptyState
          icon={LuHistory}
          color={HUE.blue}
          title="No settled trades yet"
          description="Once a market you hold expires and you claim it, your performance and trade history land here."
        />
      ) : (
        <>
          <Section title="Performance" hint={demoActive ? 'sample data' : `${stats.total} settled markets`}>
            {/* Share is offered only on REAL figures — never a sample track record. */}
            <PerformanceCard stats={stats} curve={curve} onShare={demoActive ? undefined : () => setShareOpen(true)} />
          </Section>
          <Section title="Trade history" hint={demoActive ? 'sample data' : undefined}>
            <HistoryTable history={history} />
          </Section>
        </>
      )}

      <V2RedeemModal
        position={redeeming}
        busy={!!acct.busy}
        onConfirm={handleRedeemConfirm}
        onClose={() => setRedeeming(null)}
      />

      {/* Share the settled track record as an image (win rate + curve) — legacy
          parity. Gated to real data: the button above is hidden while sample. */}
      <PerfShareCardModal
        open={shareOpen}
        onClose={() => setShareOpen(false)}
        data={
          !demoActive && stats.total > 0
            ? {
                winRate: stats.winRate,
                wins: stats.wins,
                losses: stats.losses,
                settled: stats.total,
                realizedPnl: stats.realizedPnl,
                staked: stats.staked,
                avgRoi: stats.staked > 0 ? stats.realizedPnl / stats.staked : 0,
                best: stats.best,
                streak: stats.streak
                  ? { count: stats.streak.count, won: stats.streak.result === 'won' }
                  : null,
                curve: curve.map((p) => p.cumulative),
              }
            : null
        }
      />

      {claimCelebration}

      <FundModal
        // Remount per open so the amount field always starts empty (see FundModal).
        key={fundMode ?? 'closed'}
        mode={fundMode}
        walletBase={acct.walletDusdcBase}
        accountBase={acct.balanceBase}
        address={acct.owner}
        busy={acct.busy === 'deposit' || acct.busy === 'withdraw'}
        onConfirm={handleFund}
        onClose={() => setFundMode(null)}
      />

      <SuccessModal
        open={!!fundDone}
        onClose={() => setFundDone(null)}
        title={fundDone?.mode === 'add' ? 'Funds added' : 'Withdrawn to wallet'}
        eyebrow={fundDone?.mode === 'add' ? 'Deposited' : 'Withdrawn'}
        amount={fundDone?.amount ?? 0}
        sub={
          fundDone?.mode === 'add'
            ? 'moved from your wallet into your trading account'
            : 'moved from your trading account to your wallet'
        }
        digest={fundDone?.digest}
      />

      <p className="mt-6 text-[10px] text-text-3">
        Quote asset · {predictV2Config.quote.symbol} · {predictV2Config.network}
      </p>
    </div>
  );
}

/* ─────────────────────────── create-account gate ─────────────────────────── */

/** First-run card: one transaction creates the shared trading account. */
function CreateAccountCard({ busy, onCreate }: { busy: boolean; onCreate: () => void }) {
  const steps = ['Create account', 'Fund DUSDC', 'Trade'];
  return (
    <div className="flex flex-1 items-center justify-center px-5 py-16">
      <div className="glass-card relative w-full max-w-md overflow-hidden p-8 text-center">
        {/* accent wash from the top + a faint top sheen — the one glow off-canvas */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{ background: 'radial-gradient(120% 80% at 50% 0%, var(--accent-soft), transparent 62%)' }}
        />
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-8 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent"
        />

        <div className="relative flex flex-col items-center gap-5">
          <IconChip icon={LuWalletMinimal} color={HUE.teal} size={56} />

          <div className="flex flex-col gap-2">
            <h2 className="text-[18px] font-semibold tracking-tight text-text-1">
              Create your trading account
            </h2>
            <p className="mx-auto max-w-xs text-[12.5px] leading-relaxed text-text-3">
              A personal vault that holds your DUSDC and positions on the new release. One
              transaction — then fund it and place your first bet.
            </p>
          </div>

          {/* onboarding path */}
          <div className="glass-inset flex w-full items-center justify-between gap-2 px-3.5 py-2.5">
            {steps.map((label, i) => (
              <Fragment key={label}>
                {i > 0 && <span className="h-px flex-1 bg-white/10" />}
                <span className="flex items-center gap-1.5">
                  <span
                    className={`flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-semibold ${
                      i === 0 ? 'bg-accent/20 text-accent' : 'bg-white/5 text-text-3'
                    }`}
                  >
                    {i + 1}
                  </span>
                  <span className={`text-[10px] uppercase tracking-wider ${i === 0 ? 'text-text-2' : 'text-text-3'}`}>
                    {label}
                  </span>
                </span>
              </Fragment>
            ))}
          </div>

          {/* primary CTA */}
          <button
            onClick={onCreate}
            disabled={busy}
            className="group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-(--accent-line) bg-(--accent-soft) px-4 py-3 text-[13px] font-semibold text-up transition-all duration-200 hover:bg-up/15 hover:shadow-[0_0_30px_-8px_var(--accent-glow)] disabled:opacity-50"
          >
            {busy ? 'Creating…' : 'Create trading account'}
            {!busy && (
              <LuArrowRight size={15} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            )}
          </button>

          <Link
            href="/v2"
            className="text-[11px] text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline"
          >
            ← back to the markets
          </Link>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────── deposit / withdraw ─────────────────────────── */

/**
 * FundModal — one frosted dialog for both directions: wallet → account ("add")
 * and account → wallet ("withdraw"). Mirrors the legacy WithdrawModal layout,
 * with an amount field + quick picks bounded by the available balance.
 */
function FundModal({
  mode,
  walletBase,
  accountBase,
  address,
  busy,
  onConfirm,
  onClose,
}: {
  mode: FundMode | null;
  walletBase: bigint | undefined;
  accountBase: bigint;
  address: string | undefined;
  busy: boolean;
  onConfirm: (amount: number) => void;
  onClose: () => void;
}) {
  // Empty by default — no pre-filled amount. `raw` is the string the user types
  // (lets a trailing "." and decimals survive re-renders); `amount` is its numeric
  // value. The parent keys this dialog by `mode`, so it remounts fresh on each open
  // and `raw` always starts empty.
  const [raw, setRaw] = useState('');
  const amount = Number(raw) || 0;
  const add = mode === 'add';
  const available = add ? (walletBase !== undefined ? fromQuote(walletBase) : undefined) : fromQuote(accountBase);
  const over = available !== undefined && amount > available;

  return (
    <Modal
      open={mode !== null}
      onClose={onClose}
      variant="glass"
      maxWidthClass="max-w-sm"
      title={add ? 'Add funds' : 'Withdraw'}
      subtitle={add ? 'Move DUSDC into your trading account' : 'Move funds back to your wallet'}
      footer={
        <>
          <button
            onClick={onClose}
            disabled={busy}
            className="rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/5 hover:text-text-1 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={() => onConfirm(amount)}
            disabled={busy || amount <= 0 || over}
            className="rounded-lg border border-(--accent-line) bg-(--accent-soft) px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {busy ? 'Confirming…' : over ? 'More than available' : add ? 'Confirm deposit' : 'Confirm withdraw'}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12px] leading-relaxed text-text-3">
          {add
            ? 'Funds in your trading account are what you bet with. You can withdraw anything not tied up in open bets back to your wallet anytime.'
            : 'This moves uncommitted funds back to your connected wallet. Open positions are unaffected.'}
        </p>

        <div className="glass-inset relative overflow-hidden p-4">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 100% at 100% 0%, var(--accent-soft), transparent 60%)' }}
          />

          <div className="relative flex flex-col gap-1.5">
            <span className="eyebrow">{add ? 'Adding' : 'Withdrawing'}</span>
            <div className="flex items-baseline gap-1.5 font-mono tabular-nums">
              <input
                type="text"
                inputMode="decimal"
                value={raw}
                onChange={(e) =>
                  setRaw(e.target.value.replace(/[^\d.]/g, '').replace(/(\..*)\./g, '$1'))
                }
                placeholder="0"
                aria-label="Amount in DUSDC"
                className="w-32 bg-transparent text-[30px] leading-none text-text-1 outline-none placeholder:text-text-3"
              />
              <span className="text-[13px] text-text-3">{predictV2Config.quote.symbol}</span>
            </div>
          </div>

          <div className="relative mt-3 flex flex-wrap gap-1.5">
            {[10, 25, 50].map((v) => (
              <button
                key={v}
                onClick={() => setRaw(String(v))}
                className="glass-inset px-2.5 py-1 font-mono text-[11px] tabular-nums text-text-2 transition-colors hover:text-text-1"
              >
                {v}
              </button>
            ))}
            {available !== undefined && available > 0 && (
              <button
                onClick={() => setRaw(String(Math.floor(available * 100) / 100))}
                className="glass-inset px-2.5 py-1 font-mono text-[11px] tabular-nums text-text-2 transition-colors hover:text-text-1"
              >
                Max
              </button>
            )}
          </div>

          <div className="hairline-fade relative my-3.5" />

          <div className="relative flex flex-col gap-1.5 font-mono text-[12px] tabular-nums">
            <div className="flex items-center justify-between">
              <span className="text-text-3">{add ? 'In your wallet' : 'Available'}</span>
              <span className={over ? 'text-down' : 'text-text-1'}>
                {available !== undefined ? fmtQuote(available) : '…'} {predictV2Config.quote.symbol}
              </span>
            </div>
            {!add && (
              <div className="flex items-center justify-between">
                <span className="text-text-3">To wallet</span>
                <span className="text-text-1">{address ? shortId(address, 6, 6) : '—'}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

/* ─────────────────────────── shared scaffolding ─────────────────────────── */

function SmallStat({
  icon,
  color,
  label,
  value,
  tone,
  action,
  info,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  tone?: 'up' | 'down';
  action?: React.ReactNode;
  /** Optional plain-language explanation, shown via a "?" tip beside the label. */
  info?: React.ReactNode;
}) {
  const valueColor = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1';
  return (
    <div className="glass-inset flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
        {info && <InfoTip label={label}>{info}</InfoTip>}
      </div>
      <span className={`text-[20px] leading-none tracking-tight ${valueColor}`}>{value}</span>
      {action}
    </div>
  );
}

function Section({
  title,
  hint,
  action,
  children,
}: {
  title: string;
  hint?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
          <span className="h-3 w-px bg-accent/70" />
          {title}
        </h2>
        <div className="flex items-center gap-3">
          {hint && <span className="font-mono text-[11px] tabular-nums text-text-3">{hint}</span>}
          {action}
        </div>
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{children}</div>;
}

/** Renders positions as the full-card grid or the dense row list, per `view`. */
function PositionList({
  view,
  positions,
  now,
  busy,
  onRedeem,
}: {
  view: PosView;
  positions: V2PortfolioPosition[];
  now: number;
  busy: boolean;
  onRedeem: (p: V2PortfolioPosition) => void;
}) {
  if (view === 'compact') {
    return (
      <div className="flex flex-col gap-2">
        {positions.map((p) => (
          <V2PositionRow key={p.key} position={p} now={now} busy={busy} onRedeem={onRedeem} />
        ))}
      </div>
    );
  }
  return (
    <Grid>
      {positions.map((p) => (
        <V2PositionCard key={p.key} position={p} now={now} busy={busy} onRedeem={onRedeem} />
      ))}
    </Grid>
  );
}

/** Card-grid ↔ compact-list segmented toggle (shared across the position sections). */
function ViewToggle({ view, onChange }: { view: PosView; onChange: (v: PosView) => void }) {
  return (
    <div className="glass-inset flex items-center gap-0.5 rounded-md p-0.5">
      <ViewToggleBtn active={view === 'compact'} onClick={() => onChange('compact')} icon={LuRows3} label="Compact list" />
      <ViewToggleBtn active={view === 'grid'} onClick={() => onChange('grid')} icon={LuLayoutGrid} label="Card grid" />
    </div>
  );
}
function ViewToggleBtn({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: IconType;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      title={label}
      className={`inline-flex h-6 w-7 items-center justify-center rounded transition-colors ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={13} />
    </button>
  );
}

/** A segment in the Positions/History tab strip (matches the legacy portfolio). */
function TabButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: IconType;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        active ? 'text-text-1' : 'text-text-3 hover:text-text-2',
      ].join(' ')}
    >
      <Icon size={13} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  );
}

/** Frosted-glass empty state — a tinted icon chip, a guiding line, optional CTA. */
function EmptyState({
  icon,
  color,
  title,
  description,
  action,
}: {
  icon: IconType;
  color: string;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="glass-card flex flex-col items-center gap-4 px-6 py-12 text-center">
      <IconChip icon={icon} color={color} size={44} />
      <div className="flex max-w-sm flex-col gap-1.5">
        <p className="text-[13px] font-medium text-text-1">{title}</p>
        <p className="text-[12px] leading-relaxed text-text-3">{description}</p>
      </div>
      {action}
    </div>
  );
}

/** Loading placeholder for the History tab — mirrors the Performance card + the
 *  Trade-history table so the tab paints its real shape while the order log
 *  loads, instead of flashing empty space or a premature "no trades" state. */
function HistorySkeleton() {
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">Loading trade history…</span>
      <Section title="Performance">
        <div className="glass-card flex flex-col gap-4 p-4" aria-hidden>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="glass-inset flex flex-col gap-2 p-3">
                <Skel className="h-3 w-16" />
                <Skel className="h-6 w-20" />
              </div>
            ))}
          </div>
          <Skel className="h-28 w-full rounded-lg" />
        </div>
      </Section>
      <Section title="Trade history">
        <div className="glass-card flex flex-col overflow-hidden p-3" aria-hidden>
          {/* header row */}
          <div className="mb-1 flex items-center gap-3 px-1 pb-2">
            <Skel className="h-3 w-24" />
            <Skel className="h-3 w-16" />
            <Skel className="ml-auto h-3 w-12" />
            <Skel className="h-3 w-12" />
            <Skel className="h-3 w-12" />
          </div>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3 border-t border-white/5 px-1 py-3">
              <Skel className="h-4 w-4 rounded-full" />
              <Skel className="h-4 w-28" />
              <Skel className="h-4 w-14" />
              <Skel className="ml-auto h-4 w-12" />
              <Skel className="h-4 w-12" />
              <Skel className="h-4 w-10" />
            </div>
          ))}
        </div>
      </Section>
    </div>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 py-24 text-center">{children}</div>
  );
}

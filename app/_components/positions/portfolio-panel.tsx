'use client';

/**
 * Portfolio — the trader's account home. Account header (value, free balance,
 * exposure, PnL), then open positions as cards and a settled/redeemable section.
 * All position/manager amounts are de-scaled in `positionMetrics` / here (server
 * gives @6dec base units). Redeeming routes through a confirmation modal.
 */
import { Fragment, useState } from 'react';
import Link from 'next/link';
import type { IconType } from 'react-icons';
import { LuWallet, LuWalletMinimal, LuTrendingUp, LuTrendingDown, LuLayers, LuCoins, LuDownload, LuHistory, LuArrowRight } from 'react-icons/lu';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { fromQuote } from '@/config/scale';
import { isRedeemableStatus } from './position-metrics';
import { quote as fmtQuote, signed, pct } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { PositionCard } from './position-card';
import { RangePositionCard } from './range-position-card';
import { useRangePositions, type ValuedRangePosition } from '@/lib/hooks/use-range-positions';
import { PerformanceCard } from './performance-card';
import { PointsTile } from './points-tile';
import { HistoryTable } from './history-table';
import { RedeemModal } from './redeem-modal';
import { RangeRedeemModal } from './range-redeem-modal';
import { SuccessModal } from '../ui/success-modal';
import { derivePortfolioHistory, deriveRangeHistory } from '@/lib/portfolio/history';
import { useLeaderboard } from '@/lib/hooks/use-leaderboard';
import type { PositionSummary } from '@/lib/api/types';

const EXPLORER = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;

export function PortfolioPanel({ serverNow }: { serverNow: number }) {
  const acct = usePredictAccount();
  const now = useNow(serverNow);
  const mounted = useMounted();
  // Points come from the SAME event-derived aggregation the leaderboard ranks
  // by — so the Portfolio tile and your leaderboard rank can never disagree.
  const leaderboard = useLeaderboard();
  const ranges = useRangePositions(acct.managerId);
  const [redeeming, setRedeeming] = useState<PositionSummary | null>(null);
  const [redeemingRange, setRedeemingRange] = useState<ValuedRangePosition | null>(null);
  const [tab, setTab] = useState<'positions' | 'history'>('positions');
  // Animated confirmation after a free-balance withdrawal (toast is easy to miss).
  const [withdrawDone, setWithdrawDone] = useState<{ amount: number; digest: string } | null>(null);

  // Withdraw the manager's full free balance back to the wallet; on success pop
  // the SuccessModal with the amount that moved (captured before the tx clears it).
  async function handleWithdrawAll() {
    const amount = fromQuote(acct.tradingBalanceBase);
    const digest = await acct.withdrawAll();
    if (digest) setWithdrawDone({ amount, digest });
  }

  if (!mounted) {
    return (
      <Centered>
        <p className="text-[12px] text-text-3">Loading account…</p>
      </Centered>
    );
  }

  if (!acct.owner) {
    return (
      <Centered>
        <p className="text-[13px] text-text-2">Connect a wallet to view your portfolio.</p>
        <p className="mt-1 text-[12px] text-text-3">Use the connect button in the top bar.</p>
      </Centered>
    );
  }

  if (acct.managersLoading) {
    return <Centered>
      <p className="text-[12px] text-text-3">Loading account…</p>
    </Centered>;
  }

  if (!acct.managerId) {
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
                A personal vault that holds your DUSDC and positions. One transaction — then mint
                your first contract from the surface.
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
                    <span
                      className={`text-[10px] uppercase tracking-wider ${i === 0 ? 'text-text-2' : 'text-text-3'}`}
                    >
                      {label}
                    </span>
                  </span>
                </Fragment>
              ))}
            </div>

            {/* primary CTA */}
            <button
              onClick={() => acct.createManager()}
              disabled={acct.busy === 'create'}
              className="group inline-flex w-full items-center justify-center gap-2 rounded-xl border border-(--accent-line) bg-(--accent-soft) px-4 py-3 text-[13px] font-semibold text-up transition-all duration-200 hover:bg-up/15 hover:shadow-[0_0_30px_-8px_var(--accent-glow)] disabled:opacity-50"
            >
              {acct.busy === 'create' ? 'Creating…' : 'Create trading account'}
              {acct.busy !== 'create' && (
                <LuArrowRight
                  size={15}
                  className="transition-transform duration-200 group-hover:translate-x-0.5"
                />
              )}
            </button>

            <Link
              href="/"
              className="text-[11px] text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline"
            >
              ← back to the surface
            </Link>
          </div>
        </div>
      </div>
    );
  }

  const s = acct.summary;
  const positions = acct.positions;
  // Settled in-the-money + unclaimed (status 'redeemable') → the redeem section;
  // everything else still holding quantity (status 'active') → open positions.
  const redeemable = positions.filter((p) => p.open_quantity > 0 && isRedeemableStatus(p.status));
  const open = positions.filter((p) => p.open_quantity > 0 && !isRedeemableStatus(p.status));
  const openRanges = ranges.positions.filter((p) => p.openQty > 0);

  async function handleRedeemRange(p: ValuedRangePosition, quantityBase: bigint) {
    await acct.redeemRange({
      oracleId: p.oracleId,
      expiry: p.expiry,
      lowerStrike: BigInt(Math.round(p.lowerStrike)),
      higherStrike: BigInt(Math.round(p.higherStrike)),
      quantity: quantityBase,
    });
  }

  const totalPnl = s ? fromQuote(s.realized_pnl + s.unrealized_pnl) : 0;
  const unrealized = s ? fromQuote(s.unrealized_pnl) : 0;
  const unrealizedPct = s && s.open_exposure > 0 ? s.unrealized_pnl / s.open_exposure : 0;

  // Settled track record (closed positions + closed ranges) — drives the
  // performance bento + table.
  const { history, stats } = derivePortfolioHistory(positions, deriveRangeHistory(ranges.positions));

  // Points = this trader's row in the leaderboard aggregation (same formula,
  // same inputs as the board). Undefined while the board loads → tile shows '…'.
  const myRow = leaderboard.rows.find(
    (r) => r.owner.toLowerCase() === acct.owner!.toLowerCase(),
  );
  const pointsTotal = leaderboard.loading ? undefined : myRow?.points.total ?? 0;

  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5">
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
              {s ? fmtQuote(fromQuote(s.account_value)) : '…'}
            </span>
            <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">
              {predictConfig.quote.symbol} · {predictConfig.network}
            </span>
          </div>
        </div>

        <SmallStat
          icon={totalPnl >= 0 ? LuTrendingUp : LuTrendingDown}
          color={totalPnl >= 0 ? HUE.teal : HUE.coral}
          label="Total PnL"
          value={s ? signed(totalPnl) : '…'}
          tone={totalPnl >= 0 ? 'up' : 'down'}
        />
        <SmallStat
          icon={LuLayers}
          color={HUE.blue}
          label="Open exposure"
          value={s ? fmtQuote(fromQuote(s.open_exposure)) : '…'}
        />
        <SmallStat
          icon={LuCoins}
          color={HUE.amber}
          label="Free balance"
          value={s ? fmtQuote(fromQuote(s.trading_balance)) : '…'}
          action={
            acct.tradingBalanceBase > 0n ? (
              <button
                onClick={handleWithdrawAll}
                disabled={acct.busy === 'withdraw'}
                className="group glass-inset mt-1 inline-flex w-fit items-center gap-1.5 px-2.5 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-1 transition-all duration-200 hover:border-(--accent-line) hover:text-accent disabled:opacity-50"
              >
                <LuDownload size={12} className="transition-colors duration-200 group-hover:text-accent" />
                {acct.busy === 'withdraw' ? 'withdrawing…' : 'Withdraw'}
              </button>
            ) : undefined
          }
        />
        <SmallStat
          icon={LuWalletMinimal}
          color={HUE.violet}
          label="Wallet DUSDC"
          value={acct.dusdcBalance === undefined ? '…' : fmtQuote(fromQuote(acct.dusdcBalance))}
        />

        {/* Points — a compact stat card, balancing the grid's bottom-right */}
        <PointsTile total={pointsTotal} />
      </div>

      {acct.error && (
        <div className="mb-4 rounded border border-down/40 bg-down/10 p-2 font-mono text-[12px] text-down">
          {acct.error}
        </div>
      )}

      {/* Ready to redeem (settled) — ALWAYS visible; it's claimable money and
          should never sit behind a tab. */}
      {redeemable.length > 0 && (
        <Section title="Ready to redeem" hint="settled — claim your payout">
          <Grid>
            {redeemable.map((p) => (
              <PositionCard
                key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                position={p}
                now={now}
                busy={!!acct.busy}
                onRedeem={setRedeeming}
              />
            ))}
          </Grid>
        </Section>
      )}

      {/* Positions / History — the two long sections, tabbed to keep the page
          short. Positions (live bets) is the default; History carries the
          retrospective Performance summary + trade table. */}
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
          <span className={`font-mono text-[11px] tabular-nums ${unrealized >= 0 ? 'text-up' : 'text-down'}`}>
            {signed(unrealized)} unrealized ({signed(unrealizedPct * 100, 1)}%)
          </span>
        )}
        {tab === 'history' && stats.total > 0 && (
          <span className={`font-mono text-[11px] tabular-nums ${stats.realizedPnl >= 0 ? 'text-up' : 'text-down'}`}>
            {signed(stats.realizedPnl)} realized · {pct(stats.winRate, 0)} win
          </span>
        )}
      </div>

      {tab === 'positions' ? (
        open.length === 0 && openRanges.length === 0 ? (
          <EmptyState
            icon={LuLayers}
            color={HUE.teal}
            title="No open positions yet"
            description="Pick a market on the surface to mint an UP / DOWN contract, or set a range on the odds curve."
            action={
              <Link
                href="/"
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-3.5 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15"
              >
                Open the surface
                <LuArrowRight size={14} />
              </Link>
            }
          />
        ) : (
          <div className="flex flex-col gap-5">
            {open.length > 0 && (
              <Grid>
                {open.map((p) => (
                  <PositionCard
                    key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                    position={p}
                    now={now}
                    busy={!!acct.busy}
                    onRedeem={setRedeeming}
                  />
                ))}
              </Grid>
            )}
            {openRanges.length > 0 && (
              <Section title="Vertical ranges" hint={`${openRanges.length} open`}>
                <Grid>
                  {openRanges.map((p) => (
                    <RangePositionCard
                      key={`${p.oracleId}-${p.lowerStrike}-${p.higherStrike}`}
                      position={p}
                      now={now}
                      busy={!!acct.busy}
                      onRedeem={setRedeemingRange}
                    />
                  ))}
                </Grid>
              </Section>
            )}
          </div>
        )
      ) : stats.total === 0 ? (
        <EmptyState
          icon={LuHistory}
          color={HUE.blue}
          title="No settled trades yet"
          description="Once a market you hold expires and you redeem it, your performance and trade history land here."
        />
      ) : (
        <>
          <Section title="Performance" hint={`${stats.total} settled markets`}>
            <PerformanceCard stats={stats} />
          </Section>
          <Section title="Trade history">
            <HistoryTable history={history} />
          </Section>
        </>
      )}

      {acct.lastDigest && (
        <a
          href={EXPLORER(acct.lastDigest)}
          target="_blank"
          rel="noreferrer"
          className="mt-4 inline-block font-mono text-[10px] text-text-3 underline hover:text-text-2"
        >
          last tx: {acct.lastDigest.slice(0, 12)}… ↗
        </a>
      )}

      <RedeemModal
        position={redeeming}
        busy={!!acct.busy}
        onConfirm={async (p, quantityBase) => {
          await acct.redeem(p, quantityBase);
          setRedeeming(null);
        }}
        onClose={() => setRedeeming(null)}
      />

      <RangeRedeemModal
        position={redeemingRange}
        busy={!!acct.busy}
        onConfirm={async (p, quantityBase) => {
          await handleRedeemRange(p, quantityBase);
          setRedeemingRange(null);
        }}
        onClose={() => setRedeemingRange(null)}
      />

      <SuccessModal
        open={!!withdrawDone}
        onClose={() => setWithdrawDone(null)}
        title="Withdrawn to wallet"
        eyebrow="Withdrawn"
        amount={withdrawDone?.amount ?? 0}
        sub="moved from your free balance to your wallet"
        digest={withdrawDone?.digest}
      />

      <p className="mt-6 text-[10px] text-text-3">Quote asset · {predictConfig.quote.symbol} · {predictConfig.network}</p>
    </div>
  );
}

function SmallStat({
  icon,
  color,
  label,
  value,
  tone,
  action,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  tone?: 'up' | 'down';
  action?: React.ReactNode;
}) {
  const valueColor = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1';
  return (
    <div className="glass-inset flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className={`text-[20px] leading-none tracking-tight ${valueColor}`}>{value}</span>
      {action}
    </div>
  );
}

function Section({
  title,
  hint,
  hintTone,
  children,
}: {
  title: string;
  hint?: string;
  hintTone?: 'up' | 'down';
  children: React.ReactNode;
}) {
  return (
    <section className="mb-6">
      <div className="mb-3 flex items-baseline justify-between">
        <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
          <span className="h-3 w-px bg-accent/70" />
          {title}
        </h2>
        {hint && (
          <span
            className={`font-mono text-[11px] tabular-nums ${
              hintTone === 'up' ? 'text-up' : hintTone === 'down' ? 'text-down' : 'text-text-3'
            }`}
          >
            {hint}
          </span>
        )}
      </div>
      {children}
    </section>
  );
}

function Grid({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">{children}</div>;
}

/** A segment in the Positions/History tab strip (matches the market picker). */
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

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-5 py-24 text-center">
      {children}
    </div>
  );
}

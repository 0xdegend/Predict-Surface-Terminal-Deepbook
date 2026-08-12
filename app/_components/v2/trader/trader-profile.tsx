'use client';

/**
 * V2TraderProfile — a public profile for any trader on the new deployment:
 * identity + Season-2 standing + their live open positions, each copyable into
 * the trade ticket. Reached from the leaderboard (a trader's name), so a long
 * position list gets a full page instead of a cramped overlay.
 *
 * Standing (rank / points / volume / trades) comes from the SHARED board
 * aggregation, checked VENUE-first then SKEW as a fallback, so it agrees with
 * whichever leaderboard the trader was reached from (a Skew user buried under the
 * bot in the venue indexer's backfill window still shows their Skew standing rather
 * than blank dashes). A trader on NEITHER board (only settled history) still loads
 * their win rate + positions, resolved by account id, which spans all their markets.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { LuArrowLeft, LuExternalLink, LuTrophy, LuCoins, LuActivity, LuLayers, LuShare, LuTarget } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useV2Leaderboard } from '@/lib/hooks/use-v2-leaderboard';
import { useV2TraderAccount } from '@/lib/hooks/use-v2-trader-account';
import { useV2TraderStyle } from '@/lib/hooks/use-v2-trader-style';
import { useV2History } from '@/lib/hooks/use-v2-history';
import { useMounted } from '@/lib/hooks/use-mounted';
import { sortV2Rows } from '@/lib/leaderboard/v2';
import { derivePortfolioHistory, winRateSeries } from '@/lib/portfolio/history';
import { num, compact, pct, shortId } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../../ui/metric';
import { ResponsiveSparkline } from '../../analytics/charts/sparkline';
import { WalletAvatar } from '../../leaderboard/wallet-avatar';
import { V2TraderStyleCard } from './trader-style-card';
import { V2TraderPositionsList } from './trader-positions-list';
import { V2TraderShareModal } from './trader-share-modal';
import type { TraderShareCard } from './trader-share-card-canvas';

const EXPLORER = (addr: string) => `https://suiscan.xyz/${predictV2Config.network}/account/${addr}`;

export function V2TraderProfile({ address }: { address: string }) {
  const owner = address.toLowerCase();
  const account = useCurrentAccount();
  const mounted = useMounted();
  const isMe = mounted && account?.address?.toLowerCase() === owner;

  // The trader's internal account id (resolved on-chain) → their positions feed.
  const { accountId, isLoading: accLoading } = useV2TraderAccount(owner);

  // Season-2 standing from the shared board aggregation (ranked by points). Look the
  // trader up on the VENUE board first, then fall back to the SKEW board: a genuine
  // Skew user can be missing from the venue board (buried under the high-frequency
  // bot in the indexer's backfill window) while still ranked on the Skew board they
  // were reached from. Falling back keeps their points / volume / trades / rank from
  // reading as blank dashes on their own profile.
  const { rows, skewRows, loading: lbLoading, skewLoading } = useV2Leaderboard();
  const rankedAll = useMemo(() => sortV2Rows(rows, 'points'), [rows]);
  const rankedSkew = useMemo(() => sortV2Rows(skewRows, 'points'), [skewRows]);
  const row = useMemo(
    () =>
      rows.find((r) => r.owner.toLowerCase() === owner) ??
      skewRows.find((r) => r.owner.toLowerCase() === owner) ??
      null,
    [rows, skewRows, owner],
  );
  // Rank + board size come from whichever board the row was found on, so "rank N of M"
  // stays internally consistent (a Skew-only trader gets their Skew-board rank).
  const onVenue = useMemo(() => rankedAll.some((r) => r.owner.toLowerCase() === owner), [rankedAll, owner]);
  const rankedCount = onVenue ? rankedAll.length : rankedSkew.length;
  const rank = useMemo(() => {
    const board = onVenue ? rankedAll : rankedSkew;
    const i = board.findIndex((r) => r.owner.toLowerCase() === owner);
    return i >= 0 ? i + 1 : null;
  }, [onVenue, rankedAll, rankedSkew, owner]);
  // Standing is still resolving until BOTH boards have answered (either can carry the row).
  const standingLoading = lbLoading || skewLoading;

  // Archetype for the profile share card — shares the accountOrders cache with the
  // style card + positions, so it's already loaded, not an extra fetch.
  const { style } = useV2TraderStyle(accLoading ? undefined : accountId, owner);

  // Win rate over settled bets — derived the SAME way as the trader's own
  // Portfolio (derivePortfolioHistory), and off the same cached account-orders
  // query as the style card, so it's authoritative and not an extra fetch.
  const { history, isLoading: histLoading } = useV2History(accLoading ? undefined : accountId, undefined, owner);
  const winStats = useMemo(() => derivePortfolioHistory([], history).stats, [history]);
  const winRate = winStats.total > 0 ? winStats.winRate : null;
  // Running win-rate curve for the trend chart (last point = winRate). Plotted
  // on a fixed 0–100% axis (see the chart below), so a flat run (all wins/all
  // losses) sits at its true level rather than a misleading pinned line.
  const winCurve = useMemo(() => winRateSeries(history), [history]);
  const showWinTrend = winCurve.length >= 1;
  // A single settled bet has no line to draw — pad it to a flat pair so the
  // chart still renders at its true level on the fixed 0–100% axis.
  const winCurvePlot = winCurve.length >= 2 ? winCurve : winCurve.length === 1 ? [winCurve[0], winCurve[0]] : [];

  // The share dialog: null = closed; else a profile or bet-slip card.
  const [share, setShare] = useState<TraderShareCard | null>(null);
  const shareProfile = () =>
    setShare({
      kind: 'profile',
      data: {
        trader: owner,
        rank,
        ranked: rankedCount,
        points: row?.points ?? 0,
        volume: row?.volume ?? 0,
        trades: row?.trades ?? 0,
        winRate,
        winRateCurve: winCurve,
        archetype: style?.primary?.label ?? null,
      },
    });

  const stat = (v: number, d = 2) => (standingLoading ? '…' : row ? num(v, d) : '—');

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5">
      <Link
        href="/v2/leaderboard"
        className="mb-4 inline-flex items-center gap-1.5 text-[12px] text-text-3 transition-colors hover:text-text-1"
      >
        <LuArrowLeft size={14} />
        Leaderboard
      </Link>

      {/* Identity header */}
      <div className="glass-card mb-5 flex flex-wrap items-center gap-x-5 gap-y-4 p-4">
        <WalletAvatar addr={owner} size={52} ring="color-mix(in srgb, var(--accent) 45%, transparent)" />
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2">
            <span className="eyebrow">Trader</span>
            {isMe && (
              <span className="rounded-full bg-(--accent-soft) px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-accent">
                you
              </span>
            )}
          </div>
          <a
            href={EXPLORER(owner)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[15px] text-text-1 transition-colors hover:text-accent"
            title={owner}
          >
            {shortId(owner, 8, 6)}
            <LuExternalLink size={13} className="text-text-3" />
          </a>
        </div>

        <div className="ml-auto flex flex-col items-end gap-2">
          <button
            onClick={shareProfile}
            className="ctrl-soft inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-text-2 transition-colors hover:text-text-1"
            title="Share this trader as an image"
          >
            <LuShare size={12} /> Share
          </button>
          <div className="flex flex-col items-end gap-1">
            <span className="eyebrow">Rank</span>
            <span className="font-mono text-[26px] leading-none text-accent">
              {standingLoading ? '…' : rank != null ? `#${rank}` : '—'}
            </span>
            {!standingLoading && rank != null && (
              <span className="font-mono text-[10px] tabular-nums text-text-3">of {rankedCount}</span>
            )}
          </div>
        </div>
      </div>

      {/* Standing stats */}
      <div className="glass-card mb-6 grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums sm:grid-cols-4">
        <Stat icon={LuTrophy} color={HUE.teal} label="Points" value={stat(row?.points ?? 0, 0)} accent />
        <Stat
          icon={LuTarget}
          color={HUE.violet}
          label="Win rate"
          value={histLoading ? '…' : winRate != null ? pct(winRate, 0) : '—'}
        />
        <Stat
          icon={LuCoins}
          color={HUE.amber}
          label="Volume"
          value={
            standingLoading ? '…' : !row ? '—' : (
              <>
                <span className="sm:hidden">{compact(row.volume)}</span>
                <span className="hidden sm:inline">{num(row.volume, 2)}</span>
              </>
            )
          }
          unit={predictV2Config.quote.symbol}
        />
        <Stat icon={LuActivity} color={HUE.blue} label="Trades" value={standingLoading ? '…' : row ? String(row.trades) : '—'} />
      </div>

      {/* Win-rate trend — the running win rate over settled bets, on a fixed
          0–100% axis so a flat run reads at its true level. */}
      {showWinTrend && (
        <div className="glass-card mb-6 flex items-center gap-4 p-4 font-mono tabular-nums">
          <div className="flex shrink-0 flex-col gap-1">
            <span className="eyebrow">Win rate over time</span>
            <span className="text-[22px] leading-none text-accent">{pct(winRate ?? 0, 0)}</span>
            <span className="text-[10px] text-text-3">{winStats.total} settled bets</span>
          </div>
          <div className="min-w-0 flex-1">
            <ResponsiveSparkline data={winCurvePlot} height={56} color="var(--accent)" domain={[0, 1]} />
          </div>
        </div>
      )}

      {/* Trading style — derived archetype + the evidence behind it */}
      <V2TraderStyleCard accountId={accountId} owner={owner} enabled={!accLoading} />

      {/* Open positions — copyable into the trade ticket */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <LuLayers size={14} className="text-text-3" />
          <h2 className="text-[13px] font-medium text-text-1">Open positions</h2>
        </div>
        <span className="text-[10px] text-text-3">Copy or share any bet</span>
      </div>
      <V2TraderPositionsList accountId={accountId} trader={owner} enabled={!accLoading} onShare={setShare} />

      <p className="mt-6 text-[10px] leading-relaxed text-text-3">
        Positions are public on-chain state, marked at the current price. Copy carries the market only
        (which market, direction, strike) — you set your own stake and pay the live quote. Win rate is over
        settled bets; authoritative PnL lives on the trader’s own portfolio. Quote asset ·{' '}
        {predictV2Config.quote.symbol} · {predictV2Config.network}.
      </p>

      <V2TraderShareModal card={share} onClose={() => setShare(null)} />
    </div>
  );
}

function Stat({
  icon,
  color,
  label,
  value,
  unit,
  accent,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: React.ReactNode;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-2 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span
        className={`whitespace-nowrap text-[16px] leading-none tracking-tight sm:text-[20px] ${accent ? 'text-accent' : 'text-text-1'}`}
      >
        {value}
        {unit && <span className="ml-1 hidden text-[11px] text-text-3 sm:inline">{unit}</span>}
      </span>
    </div>
  );
}

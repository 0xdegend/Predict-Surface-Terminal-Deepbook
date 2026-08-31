'use client';

/**
 * V2Season1Archive — the FROZEN Season 1 (6-24) leaderboard, rendered straight from
 * the stored snapshot (lib/leaderboard/legacy-points-6-24.json via legacy-carryover).
 *
 * Season 1 ran on the 6-24 Predict release, which was retired when Mysten republished
 * the protocol (see predict-refresh-8-06). Its board can't be recomputed anymore — the
 * backend is gone — so we show the one-time snapshot we captured on the final day. This
 * view needs NO backend: it always loads, even when the live deployment is down. The
 * same snapshot also carries over as a baseline on the live Season 2 board
 * (mergeLegacyCarryover); this page just presents it on its own.
 *
 * Visual language mirrors V2LeaderboardPanel (trophy header, totals strip, gold/silver/
 * bronze podium, glass table). Trimmed for a static board: no scope tabs, refresh, or
 * pagination (15 rows). The connected wallet is highlighted if it placed in Season 1.
 */
import Link from 'next/link';
import { LuTrophy, LuUsers, LuActivity, LuCoins, LuCrown, LuArrowLeft } from 'react-icons/lu';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useMounted } from '@/lib/hooks/use-mounted';
import { num, compact } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { TraderName } from '../leaderboard/trader-name';
import {
  SEASON_1_ROWS,
  SEASON_1_CAPTURED_AT,
  SEASON_1_SOURCE,
  type LegacyRow,
} from '@/lib/leaderboard/legacy-season1';

const EXPLORER = (addr: string) => `https://suiscan.xyz/${predictV2Config.network}/account/${addr}`;
const RANK_HUE = ['#e8c14e', '#c2cbd4', '#c08a5a']; // gold / silver / bronze
/** Table column template — # · Trader · Points · Volume (matches the live board). */
const COLS = 'grid-cols-[2rem_1fr_4.5rem_4.5rem] sm:grid-cols-[2.5rem_1fr_7rem_7rem]';

// Sorted once at module load — the snapshot never changes.
const RANKED: LegacyRow[] = [...SEASON_1_ROWS].sort((a, b) => b.points - a.points);
const TOTALS = {
  traders: RANKED.length,
  points: RANKED.reduce((s, r) => s + r.points, 0),
  volume: RANKED.reduce((s, r) => s + r.volume, 0),
  trades: RANKED.reduce((s, r) => s + r.trades, 0),
};

const capturedLabel = (() => {
  const d = new Date(SEASON_1_CAPTURED_AT);
  return Number.isNaN(d.getTime())
    ? null
    : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
})();

export function V2Season1Archive() {
  const account = useCurrentAccount();
  const mounted = useMounted();
  const me = mounted ? (account?.address?.toLowerCase() ?? null) : null;

  const podium = RANKED.slice(0, 3);
  const rest = RANKED.slice(3);

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      {/* Header */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-1">Archive · Season 1</p>
          <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
            <LuTrophy size={18} className="text-accent" />
            Season 1 leaderboard
          </h1>
          <p className="mt-1 text-[12px] text-text-3">
            Final standings from the first Predict release ({SEASON_1_SOURCE})
            {capturedLabel ? `, captured ${capturedLabel}` : ''} · a frozen snapshot, ranked by Points
          </p>
        </div>
        <Link
          href="/v2/leaderboard"
          className="group glass-inset inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
        >
          <LuArrowLeft size={12} className="transition-transform duration-200 group-hover:-translate-x-0.5" />
          Season 2 (live)
        </Link>
      </div>

      {/* Totals strip */}
      <div className="glass-card mb-5 grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums sm:grid-cols-4">
        <Stat icon={LuUsers} color={HUE.blue} label="Traders" value={String(TOTALS.traders)} />
        <Stat icon={LuTrophy} color={HUE.teal} label="Points" value={num(TOTALS.points, 0)} accent />
        <Stat
          icon={LuCoins}
          color={HUE.amber}
          label="Volume"
          value={
            <>
              <span className="sm:hidden">{compact(TOTALS.volume)}</span>
              <span className="hidden sm:inline">{num(TOTALS.volume, 2)}</span>
            </>
          }
          unit={predictV2Config.quote.symbol}
        />
        <Stat icon={LuActivity} color={HUE.violet} label="Trades" value={num(TOTALS.trades, 0)} />
      </div>

      {/* Podium — top three by points */}
      <div className="mb-5 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
        {podium.map((row, rank) => (
          <PodiumCard key={row.owner} rank={rank} row={row} isMe={me != null && row.owner.toLowerCase() === me} />
        ))}
      </div>

      {/* Table — rank 4 onward */}
      <div className="glass-card overflow-hidden">
        <div className={`head-divider grid ${COLS} items-center gap-2 px-4 py-3 text-[10px] font-medium uppercase tracking-wider text-text-3`}>
          <span className="text-right">#</span>
          <span>Trader</span>
          <span className="text-right">Points</span>
          <span className="text-right">Volume</span>
        </div>
        <div className="rows-divided">
          {rest.map((r, idx) => {
            const rank = idx + 4; // podium held 1..3
            const isMe = me != null && r.owner.toLowerCase() === me;
            return (
              <div
                key={r.owner}
                className={`grid ${COLS} items-center gap-2 px-4 py-3.5 font-mono text-[12px] tabular-nums transition-colors hover:bg-white/2 ${
                  isMe ? 'bg-(--accent-soft)' : ''
                }`}
              >
                <span className="text-right font-semibold text-text-3">{rank}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <TraderLabel owner={r.owner} isMe={isMe} />
                </span>
                <span className="text-right font-semibold text-accent">{num(r.points, 0)}</span>
                <span className="text-right text-text-1">{num(r.volume, 2)}</span>
              </div>
            );
          })}
        </div>
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-text-3">
        This is a frozen snapshot of the Season 1 ({SEASON_1_SOURCE}) Skew board, kept because that release
        was retired and its board can no longer be recomputed. Points = liquidity (DUSDC staked) +
        performance (net profit, floored at zero) + holding time. Every Season 1 trader keeps these points
        as a starting baseline on the live{' '}
        <Link href="/v2/leaderboard" className="underline hover:text-text-2">
          Season 2 board
        </Link>
        . Quote asset · {predictV2Config.quote.symbol}.
      </p>
    </div>
  );
}

/** A trader's name cell — explorer-linked (works with no backend), with a "you" tag
 *  for the connected wallet. */
function TraderLabel({ owner, isMe }: { owner: string; isMe: boolean }) {
  return (
    <a
      href={EXPLORER(owner)}
      target="_blank"
      rel="noreferrer"
      className="truncate text-text-1 hover:text-accent hover:underline"
      title={owner}
    >
      <TraderName owner={owner} />
      {isMe && <span className="ml-1.5 text-[10px] text-accent">you</span>}
    </a>
  );
}

/** Podium card — winner center (gold), runner-up left (silver), third right (bronze),
 *  matching the live board's podium-card glass treatment. */
function PodiumCard({ rank, row, isMe }: { rank: number; row: LegacyRow; isMe: boolean }) {
  const SM_ORDER = ['sm:order-2', 'sm:order-1', 'sm:order-3'][rank];
  const hue = RANK_HUE[rank];
  const champion = rank === 0;
  return (
    <div
      className={`podium-card relative flex flex-col items-center p-4 text-center transition-transform ${SM_ORDER} ${
        champion ? 'champion sm:-translate-y-2 sm:pt-6 sm:pb-5' : ''
      }`}
      style={{ ['--rank-hue' as string]: hue }}
    >
      <div
        className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold"
        style={{ color: hue, background: `color-mix(in srgb, ${hue} 16%, transparent)` }}
      >
        {champion && <LuCrown size={13} />}#{rank + 1}
      </div>
      <WalletAvatar addr={row.owner} size={champion ? 64 : 48} ring={`color-mix(in srgb, ${hue} 50%, transparent)`} />
      <span className="mt-3 inline-flex items-center gap-1.5 font-mono text-[12px]">
        <TraderLabel owner={row.owner} isMe={isMe} />
      </span>
      <div className="mt-2.5 font-mono tabular-nums">
        <span className={champion ? 'text-[24px] leading-none' : 'text-[20px] leading-none'} style={{ color: 'var(--accent)' }}>
          {num(row.points, 0)}
        </span>
        <span className="ml-1 text-[10px] text-text-3">pts</span>
      </div>
      <span className="eyebrow mt-1.5">Points</span>
      <div className="mt-3 flex w-full items-center justify-center gap-4 border-t border-white/5 pt-2.5 font-mono text-[11px] tabular-nums">
        <span className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] uppercase tracking-wider text-text-3">Vol</span>
          <span className="text-text-2">{num(row.volume, 2)}</span>
        </span>
        <span className="flex flex-col items-center gap-0.5">
          <span className="text-[9px] uppercase tracking-wider text-text-3">Trades</span>
          <span className="text-text-2">{row.trades}</span>
        </span>
      </div>
    </div>
  );
}

function Stat({
  icon: Icon,
  color,
  label,
  value,
  unit,
  accent = false,
}: {
  icon: typeof LuUsers;
  color: string;
  label: string;
  value: React.ReactNode;
  unit?: string;
  accent?: boolean;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-2 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={Icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span
        className={`whitespace-nowrap text-[16px] leading-none tracking-tight sm:text-[20px] ${
          accent ? 'text-accent' : 'text-text-1'
        }`}
      >
        {value}
        {unit && <span className="ml-1 hidden text-[11px] text-text-3 sm:inline">{unit}</span>}
      </span>
    </div>
  );
}

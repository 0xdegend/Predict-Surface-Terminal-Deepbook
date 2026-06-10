'use client';

/**
 * TraderProfile — a public profile for any trader: identity + leaderboard
 * standing + their live open positions. Reached from the leaderboard (replaces
 * the old positions modal, so a long position list gets a full page that scrolls
 * naturally instead of a cramped overlay). Server-data only — renders for any
 * visitor; the connected wallet's own profile is tagged "you".
 *
 * The standing (rank / points / volume / trades) comes from the shared
 * leaderboard aggregation, so it can never disagree with the board.
 */
import { useMemo } from 'react';
import Link from 'next/link';
import { useQuery } from '@tanstack/react-query';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { LuArrowLeft, LuExternalLink, LuTrophy, LuCoins, LuActivity, LuLayers } from 'react-icons/lu';
import { getManagersByOwner, qk } from '@/lib/api/client';
import { useLeaderboard } from '@/lib/hooks/use-leaderboard';
import { useMounted } from '@/lib/hooks/use-mounted';
import { sortRows } from '@/lib/leaderboard/aggregate';
import { num, compact, shortId } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { TraderPositionsList } from './trader-positions-list';
import type { IconType } from 'react-icons';

const EXPLORER = (addr: string) => `https://suiscan.xyz/${predictConfig.network}/account/${addr}`;

export function TraderProfile({ address }: { address: string }) {
  const owner = address.toLowerCase();
  const account = useCurrentAccount();
  const mounted = useMounted();
  const isMe = mounted && account?.address?.toLowerCase() === owner;

  // Managers for this owner → the ids we read positions/ranges from.
  const managersQ = useQuery({
    queryKey: qk.managers(owner),
    queryFn: () => getManagersByOwner(owner),
    enabled: !!owner,
  });
  const managerIds = useMemo(
    () => (managersQ.data ?? []).map((m) => m.manager_id),
    [managersQ.data],
  );

  // Standing from the shared board aggregation (rank by points).
  const { rows, loading: lbLoading } = useLeaderboard();
  const ranked = useMemo(() => sortRows(rows, 'points'), [rows]);
  const rank = useMemo(() => {
    const i = ranked.findIndex((r) => r.owner.toLowerCase() === owner);
    return i >= 0 ? i + 1 : null;
  }, [ranked, owner]);
  const row = useMemo(
    () => rows.find((r) => r.owner.toLowerCase() === owner) ?? null,
    [rows, owner],
  );

  const stat = (v: number, d = 2) => (lbLoading ? '…' : row ? num(v, d) : '—');

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5">
      <Link
        href="/leaderboard"
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
              <span className="rounded-full bg-[var(--accent-soft)] px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wider text-[var(--accent)]">
                you
              </span>
            )}
          </div>
          <a
            href={EXPLORER(owner)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[15px] text-text-1 transition-colors hover:text-[var(--accent)]"
            title={owner}
          >
            {shortId(owner, 8, 6)}
            <LuExternalLink size={13} className="text-text-3" />
          </a>
        </div>

        <div className="ml-auto flex flex-col items-end gap-1">
          <span className="eyebrow">Rank</span>
          <span className="font-mono text-[26px] leading-none text-[var(--accent)]">
            {lbLoading ? '…' : rank != null ? `#${rank}` : '—'}
          </span>
          {!lbLoading && rank != null && (
            <span className="font-mono text-[10px] tabular-nums text-text-3">of {ranked.length}</span>
          )}
        </div>
      </div>

      {/* Standing stats */}
      <div className="glass-card mb-6 grid grid-cols-3 gap-2.5 p-2.5 font-mono tabular-nums">
        <Stat icon={LuTrophy} color={HUE.teal} label="Points" value={stat(row?.points.total ?? 0, 0)} accent />
        <Stat
          icon={LuCoins}
          color={HUE.amber}
          label="Volume"
          value={
            lbLoading ? '…' : !row ? '—' : (
              <>
                {/* Compact on mobile (fits the 3-up grid), full figure from sm up. */}
                <span className="sm:hidden">{compact(row.volume)}</span>
                <span className="hidden sm:inline">{num(row.volume, 2)}</span>
              </>
            )
          }
          unit={predictConfig.quote.symbol}
        />
        <Stat icon={LuActivity} color={HUE.blue} label="Trades" value={lbLoading ? '…' : row ? String(row.trades) : '—'} />
      </div>

      {/* Open positions */}
      <div className="mb-3 flex items-center gap-2">
        <LuLayers size={14} className="text-text-3" />
        <h2 className="text-[13px] font-medium text-text-1">Open positions</h2>
      </div>
      <TraderPositionsList managerIds={managerIds} enabled={!managersQ.isLoading} />

      <p className="mt-6 text-[10px] leading-relaxed text-text-3">
        Positions are public on-chain state, valued at the current mark. Authoritative win rate & PnL
        live on the trader’s own portfolio. Quote asset · {predictConfig.quote.symbol} · {predictConfig.network}.
      </p>
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
        className={`whitespace-nowrap text-[16px] leading-none tracking-tight sm:text-[20px] ${accent ? 'text-[var(--accent)]' : 'text-text-1'}`}
      >
        {value}
        {/* Unit dropped on mobile (the label carries it) so wide values never
            collide across the 3-up grid; restored from sm up. */}
        {unit && <span className="ml-1 hidden text-[11px] text-text-3 sm:inline">{unit}</span>}
      </span>
    </div>
  );
}

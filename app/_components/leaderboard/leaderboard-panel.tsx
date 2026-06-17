'use client';

/**
 * Leaderboard — top traders on Predict, ranked by Points (and Volume). Points
 * and volume are computed from the global event streams (see aggregate.ts), so
 * the board is complete for every trader. Authoritative win rate & PnL live on
 * each trader's Portfolio. Server-data only — renders for any visitor; the
 * connected wallet's row is highlighted.
 */
import { useState } from 'react';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import {
  LuTrophy,
  LuUsers,
  LuActivity,
  LuCoins,
  LuRefreshCw,
  LuChevronLeft,
  LuChevronRight,
  LuCrown,
  LuLayers,
  LuGlobe,
  LuSparkles,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useLeaderboard } from '@/lib/hooks/use-leaderboard';
import { useSkewTraders } from '@/lib/hooks/use-skew-traders';
import { useMounted } from '@/lib/hooks/use-mounted';
import { sortRows, leaderboardTotals, type SortKey } from '@/lib/leaderboard/aggregate';
import { num, compact } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { ErrorState } from '../ui/error-state';
import { WalletAvatar } from './wallet-avatar';
import { TraderName } from './trader-name';
import Link from 'next/link';

type Row = ReturnType<typeof sortRows>[number];

const EXPLORER = (addr: string) => `https://suiscan.xyz/${predictConfig.network}/account/${addr}`;
const RANK_HUE = ['#e8c14e', '#c2cbd4', '#c08a5a']; // gold / silver / bronze
const PAGE_SIZE = 25;

/** Table column template — # · Trader · Points · Volume. Tighter value columns
 *  on mobile so the trader name keeps room; full width from sm up. */
const COLS = 'grid-cols-[2rem_1fr_4.5rem_4.5rem] sm:grid-cols-[2.5rem_1fr_7rem_7rem]';

const SORT_LABEL: Record<SortKey, string> = {
  points: 'Points',
  volume: 'Volume',
};

export function LeaderboardPanel() {
  const { rows, loading, refreshing, error, refetch } = useLeaderboard();
  const account = useCurrentAccount();
  const mounted = useMounted();
  const [sort, setSort] = useState<SortKey>('points');
  const [page, setPage] = useState(0);
  // 'all' = the whole DeepBook Predict protocol; 'skew' = only addresses that
  // have traded through Skew (the on-chain FeeCharged roster).
  const [scope, setScope] = useState<'all' | 'skew'>('all');
  const skew = useSkewTraders();

  // Switching the ranking reorders everything → jump back to the top page.
  function selectSort(key: SortKey) {
    setSort(key);
    setPage(0);
  }
  function selectScope(next: 'all' | 'skew') {
    setScope(next);
    setPage(0);
  }

  if (error) {
    return (
      <ErrorState
        title="Failed to load leaderboard"
        message={error}
        note="Usually a transient network hiccup — the public server is reachable."
      />
    );
  }

  // 'skew' scope filters the protocol roster to addresses in the FeeCharged set
  // (empty until that set loads, so the table shows its loading skeleton).
  const scopedRows =
    scope === 'skew'
      ? skew.data
        ? rows.filter((r) => skew.data!.addresses.has(r.owner.toLowerCase()))
        : []
      : rows;
  const sorted = sortRows(scopedRows, sort);
  const totals = leaderboardTotals(scopedRows);
  const listLoading = loading || (scope === 'skew' && skew.loading);
  const me = mounted ? account?.address ?? null : null;

  // The connected wallet's standing — pinned at the top so a trader can find
  // themselves without paging. -1 when not connected or not yet on the board.
  const myIndex = me ? sorted.findIndex((r) => r.owner.toLowerCase() === me.toLowerCase()) : -1;
  const myRow = myIndex >= 0 ? sorted[myIndex] : null;

  // Pagination — clamp the active page in render (no effect) so a shrinking
  // dataset after a refetch can never strand us on an empty page.
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const paginated = sorted.length > PAGE_SIZE;

  // The podium owns the top three on the first page; the table picks up from
  // rank 4 there so nobody is listed twice. Other pages table everything.
  const showPodium = !listLoading && safePage === 0 && sorted.length > 0;
  const podiumRows = showPodium ? sorted.slice(0, 3) : [];
  const tableStart = showPodium ? Math.min(3, sorted.length) : start;
  const pageRows = sorted.slice(tableStart, start + PAGE_SIZE);
  const pageEnd = start + (showPodium ? podiumRows.length : 0) + pageRows.length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      {/* Header */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
            <LuTrophy size={18} className="text-[var(--accent)]" />
            Leaderboard
          </h1>
          <p className="mt-1 text-[12px] text-text-3">
            {scope === 'skew'
              ? 'Only traders who bet through Skew'
              : 'The whole DeepBook Predict protocol'}{' '}
            · ranked by Points · {predictConfig.network}
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={loading}
          className="group glass-inset inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 disabled:opacity-50"
        >
          <LuRefreshCw
            size={12}
            className={`transition-colors duration-200 group-hover:text-accent ${refreshing ? 'animate-spin' : ''}`}
          />
          Refresh
        </button>
      </div>

      {/* Scope: the whole protocol vs only addresses that have traded on Skew
          (from the on-chain fee-router events). Hidden when the router isn't
          configured for this network. */}
      {skew.available && (
        <div className="mb-4 flex items-center gap-1.5">
          <ScopeTab
            label="All protocol"
            icon={LuGlobe}
            active={scope === 'all'}
            onClick={() => selectScope('all')}
          />
          <ScopeTab
            label="Skew traders"
            icon={LuSparkles}
            active={scope === 'skew'}
            onClick={() => selectScope('skew')}
            count={skew.data ? skew.data.addresses.size : undefined}
            loading={skew.loading}
          />
        </div>
      )}

      {/* Totals strip */}
      <div className="glass-card mb-5 grid grid-cols-3 gap-2.5 p-2.5 font-mono tabular-nums">
        <Stat icon={LuUsers} color={HUE.blue} label="Traders" value={String(totals.traders)} />
        <Stat
          icon={LuCoins}
          color={HUE.amber}
          label="Volume"
          value={
            <>
              {/* Compact on mobile (fits the 3-up grid), full figure from sm up. */}
              <span className="sm:hidden">{compact(totals.volume)}</span>
              <span className="hidden sm:inline">{num(totals.volume, 2)}</span>
            </>
          }
          unit={predictConfig.quote.symbol}
        />
        <Stat icon={LuActivity} color={HUE.teal} label="Trades" value={num(totals.trades, 0)} />
      </div>

      {/* Sort tabs */}
      <div className="mb-3 flex items-center gap-1">
        <SortTab label="Points" active={sort === 'points'} onClick={() => selectSort('points')} />
        <SortTab label="Volume" active={sort === 'volume'} onClick={() => selectSort('volume')} />
        <span className="ml-auto text-[10px] text-text-3">
          Win rate &amp; PnL on your{' '}
          <a href="/portfolio" className="underline hover:text-text-2">
            Portfolio
          </a>
        </span>
      </div>

      {/* Podium — top three for the active ranking */}
      {showPodium && <Podium rows={podiumRows} sort={sort} me={me} />}

      {/* Your standing — placed under the podium so the connected wallet finds
          itself instantly without paging */}
      {!listLoading && myRow ? (
        <MyRankCard rank={myIndex + 1} total={sorted.length} row={myRow} />
      ) : !listLoading && me && sorted.length > 0 ? (
        <NotRankedHint />
      ) : null}

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <div className={`head-divider grid ${COLS} items-center gap-2 px-4 py-3 text-[10px] font-medium uppercase tracking-wider text-text-3`}>
          <span className="text-right">#</span>
          <span>Trader</span>
          <span className="text-right">Points</span>
          <span className="text-right">Volume</span>
        </div>

        <div className="rows-divided">
        {listLoading ? (
          <SkeletonRows />
        ) : sorted.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-text-2">
            {scope === 'skew' ? 'No one has traded on Skew yet.' : 'No trading activity yet.'}
          </div>
        ) : (
          <>
          {pageRows.map((r, idx) => {
            const i = tableStart + idx; // global rank index (continues across pages)
            const isMe = me != null && r.owner.toLowerCase() === me.toLowerCase();
            return (
              <div
                key={r.owner}
                className={`grid ${COLS} items-center gap-2 px-4 py-3.5 font-mono text-[12px] tabular-nums transition-colors hover:bg-white/[0.02] ${
                  isMe ? 'bg-[var(--accent-soft)]' : ''
                }`}
              >
                <span className="text-right font-semibold text-text-3">{i + 1}</span>
                <span className="flex min-w-0 items-center gap-2">
                  <a
                    href={EXPLORER(r.owner)}
                    target="_blank"
                    rel="noreferrer"
                    className="truncate text-text-1 hover:text-[var(--accent)] hover:underline"
                    title={r.owner}
                  >
                    <TraderName owner={r.owner} />
                    {isMe && <span className="ml-1.5 text-[10px] text-[var(--accent)]">you</span>}
                  </a>
                  <ViewPositionsButton owner={r.owner} variant="icon" />
                </span>
                <span className="text-right font-semibold text-[var(--accent)]">{num(r.points.total, 0)}</span>
                <span className="text-right text-text-1">{num(r.volume, 2)}</span>
              </div>
            );
          })}
          {paginated && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="font-mono text-[11px] tabular-nums text-text-3">
                {start + 1}–{pageEnd}{' '}
                <span className="text-text-2">of {sorted.length}</span> traders
              </span>
              <Pager page={safePage} pageCount={pageCount} onPage={setPage} />
            </div>
          )}
          </>
        )}
        </div>
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-text-3">
        Points = liquidity (DUSDC minted) + performance (net profit, floored at zero — a loss never
        subtracts) + holding time, computed live from the event stream within the latest window, so
        every trader is ranked. Win rate &amp; authoritative PnL are on your{' '}
        <a href="/portfolio" className="underline hover:text-text-2">Portfolio</a>. Quote asset ·{' '}
        {predictConfig.quote.symbol}.
      </p>
    </div>
  );
}

/**
 * Links to a trader's profile (open positions + standing). Two variants:
 *   icon  — tight icon-only chip for dense table rows
 *   label — frosted-glass pill (auto-width) for the your-rank / podium cards
 *
 * The labelled variant sits on the existing `.glass-inset` surface (no hard
 * white border) and carries the app's single accent in a small layers chip; on
 * hover an accent wash + faint top sheen fade in and the border lifts to accent.
 * Flat (no shadow) so it never competes with the surface's glow budget (§10.3).
 */
function ViewPositionsButton({
  owner,
  variant = 'label',
}: {
  owner: string;
  variant?: 'icon' | 'label';
}) {
  if (variant === 'icon') {
    return (
      <Link
        href={`/trader/${owner}`}
        aria-label="View trader profile"
        title="View trader profile"
        className="group glass-inset inline-flex h-7 w-7 flex-none items-center justify-center text-text-3 transition-all duration-200 hover:border-(--accent-line) hover:text-accent"
      >
        <LuLayers size={12} className="transition-transform duration-200 group-hover:scale-110" />
      </Link>
    );
  }

  return (
    <Link
      href={`/trader/${owner}`}
      className="group glass-inset relative inline-flex items-center gap-2 overflow-hidden px-3 py-2 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
    >
      {/* accent wash — fades in on hover (flat, no shadow) */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-(--accent-soft) opacity-0 transition-opacity duration-200 group-hover:opacity-100"
      />
      {/* faint accent sheen along the top edge */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-3 top-0 h-px opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{
          background:
            'linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 60%, transparent), transparent)',
        }}
      />
      {/* accent layers chip — the bit of colour that makes it read as designed */}
      <span className="relative inline-flex h-5 w-5 items-center justify-center rounded-md bg-accent/10 text-accent transition-colors duration-200 group-hover:bg-accent/20">
        <LuLayers size={12} />
      </span>
      <span className="relative">View positions</span>
    </Link>
  );
}

/* ------------------------------------------------------------------ *
 * Your standing — the connected wallet's own row, lifted out of the list
 * and pinned to the top with its live rank, so a trader never has to page
 * to find themselves. Tinted with the accent so it reads as "you".
 * ------------------------------------------------------------------ */
function MyRankCard({ rank, total, row }: { rank: number; total: number; row: Row }) {
  return (
    <div className="mb-4 flex flex-col gap-3.5 rounded-2xl border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-3.5 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-5 sm:gap-y-3">
      {/* Identity — rank · avatar · address. Kept as one unit so it never splits. */}
      <div className="flex items-center gap-3 sm:gap-5">
        <div className="flex flex-col items-center leading-none">
          <span className="eyebrow mb-1">Your rank</span>
          <span className="font-mono text-[22px] leading-none text-[var(--accent)]">#{rank}</span>
        </div>
        <WalletAvatar addr={row.owner} size={40} ring="color-mix(in srgb, var(--accent) 55%, transparent)" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <a
            href={EXPLORER(row.owner)}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 font-mono text-[13px] text-text-1 hover:text-[var(--accent)] hover:underline"
            title={row.owner}
          >
            <TraderName owner={row.owner} />
            <span className="text-[10px] text-[var(--accent)]">you</span>
          </a>
          <span className="font-mono text-[10px] tabular-nums text-text-3">of {total} traders</span>
        </div>
      </div>

      {/* Stats + action — a 3-up row spread across the card on mobile, with the
          button below; collapses inline (pushed right) from sm up. */}
      <div className="flex flex-col gap-3 sm:ml-auto sm:flex-row sm:items-center sm:gap-5">
        <div className="flex items-center justify-between gap-x-5 gap-y-2 font-mono tabular-nums sm:justify-end">
          <RankStat label="Points">
            <span className="text-[var(--accent)]">{num(row.points.total, 0)}</span>
          </RankStat>
          <RankStat label="Volume">
            <span className="text-text-1">{num(row.volume, 2)}</span>
            <span className="ml-1 text-[10px] text-text-3">{predictConfig.quote.symbol}</span>
          </RankStat>
          <RankStat label="Trades">
            <span className="text-text-2">{row.trades}</span>
          </RankStat>
        </div>
        {/* `sm:contents` drops this wrapper on desktop so the button sits inline
            after the stats; on mobile it centers the button on its own row. */}
        <div className="flex justify-center sm:contents">
          <ViewPositionsButton owner={row.owner} />
        </div>
      </div>
    </div>
  );
}

function RankStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col items-end gap-1">
      <span className="text-[9px] uppercase tracking-wider text-text-3">{label}</span>
      <span className="text-[13px] leading-none">{children}</span>
    </span>
  );
}

/** Connected but not yet on the board — guide them to their first trade. */
function NotRankedHint() {
  return (
    <div className="glass-inset relative mb-4 flex items-center gap-2.5 overflow-hidden rounded-2xl px-4 py-3 text-[12px] text-text-2">
      {/* faint top sheen — the glass edge catching light */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent"
      />
      <LuTrophy size={14} className="flex-none text-text-3" />
      You&apos;re connected but haven&apos;t traded yet — mint a position to claim your spot on the leaderboard.
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Podium — the top three for the active ranking. The winner sits in the
 * raised center column (gold), runner-up left (silver), third right
 * (bronze), echoing a physical podium. Each card leads with the metric
 * the board is currently sorted by, then carries the other figures small.
 * ------------------------------------------------------------------ */
function Podium({ rows, sort, me }: { rows: Row[]; sort: SortKey; me: string | null }) {
  // DOM order is rank order (#1 · #2 · #3) so the mobile single-column stack —
  // and screen readers — read top-to-bottom as 1, 2, 3. On sm+ CSS `order`
  // re-creates the classic podium (2nd · 1st · 3rd, winner tallest in the
  // middle); the horizontal metaphor only makes sense when it's a row.
  const SM_ORDER = ['sm:order-2', 'sm:order-1', 'sm:order-3']; // by rank 0,1,2
  return (
    <div className="mb-5 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
      {rows.map((row, rank) => (
        <PodiumCard
          key={row.owner}
          rank={rank}
          row={row}
          sort={sort}
          isMe={me != null && row.owner.toLowerCase() === me.toLowerCase()}
          orderClass={SM_ORDER[rank]}
        />
      ))}
    </div>
  );
}

/** Primary metric for a podium card, following the active sort. */
function primaryMetric(row: Row, sort: SortKey): { value: string; unit?: string; accent: boolean } {
  if (sort === 'volume') return { value: num(row.volume, 2), unit: predictConfig.quote.symbol, accent: false };
  return { value: num(row.points.total, 0), unit: 'pts', accent: true };
}

function PodiumCard({
  rank,
  row,
  sort,
  isMe,
  orderClass,
}: {
  rank: number;
  row: Row;
  sort: SortKey;
  isMe: boolean;
  /** sm+ flex/grid order so the row reads 2nd · 1st · 3rd (podium). */
  orderClass?: string;
}) {
  const hue = RANK_HUE[rank];
  const champion = rank === 0;
  const m = primaryMetric(row, sort);
  const valueColor = m.accent ? 'var(--accent)' : 'var(--text-1)';

  // Secondary figures — the metrics that aren't the headline.
  const secondaries: { label: string; node: React.ReactNode }[] = [];
  if (sort !== 'points') secondaries.push({ label: 'Points', node: <span className="text-[var(--accent)]">{num(row.points.total, 0)}</span> });
  if (sort !== 'volume') secondaries.push({ label: 'Vol', node: num(row.volume, 2) });
  secondaries.push({ label: 'Trades', node: row.trades });

  return (
    <div
      className={`podium-card relative flex flex-col items-center p-4 text-center transition-transform ${orderClass ?? ''} ${
        champion ? 'champion sm:-translate-y-2 sm:pt-6 sm:pb-5' : ''
      }`}
      style={{ ['--rank-hue' as string]: hue }}
    >
      {/* Rank medal */}
      <div
        className="mb-3 inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 text-[11px] font-semibold"
        style={{ color: hue, background: `color-mix(in srgb, ${hue} 16%, transparent)` }}
      >
        {champion && <LuCrown size={13} />}#{rank + 1}
      </div>

      {/* Avatar — deterministic wallet identicon */}
      <WalletAvatar
        addr={row.owner}
        size={champion ? 64 : 48}
        ring={`color-mix(in srgb, ${hue} 50%, transparent)`}
      />

      {/* Address */}
      <a
        href={EXPLORER(row.owner)}
        target="_blank"
        rel="noreferrer"
        className="mt-3 inline-flex items-center gap-1.5 font-mono text-[12px] text-text-1 hover:text-[var(--accent)] hover:underline"
        title={row.owner}
      >
        <TraderName owner={row.owner} />
        {isMe && <span className="text-[10px] text-[var(--accent)]">you</span>}
      </a>

      {/* Headline metric (active sort) */}
      <div className="mt-2.5 font-mono tabular-nums">
        <span className={champion ? 'text-[24px] leading-none' : 'text-[20px] leading-none'} style={{ color: valueColor }}>
          {m.value}
        </span>
        {m.unit && <span className="ml-1 text-[10px] text-text-3">{m.unit}</span>}
      </div>
      <span className="eyebrow mt-1.5">{SORT_LABEL[sort]}</span>

      {/* Secondary figures */}
      <div className="mt-3 flex w-full items-center justify-center gap-4 border-t border-white/[0.05] pt-2.5 font-mono text-[11px] tabular-nums">
        {secondaries.map((s) => (
          <span key={s.label} className="flex flex-col items-center gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-text-3">{s.label}</span>
            <span className="text-text-2">{s.node}</span>
          </span>
        ))}
      </div>

      <div className="mt-3 flex w-full justify-center">
        <ViewPositionsButton owner={row.owner} />
      </div>
    </div>
  );
}

/** Page-number window with ellipses: 1 2 … 4 [5] 6 … 11 12. */
function pageItems(current: number, count: number): (number | 'gap')[] {
  if (count <= 7) return Array.from({ length: count }, (_, i) => i);
  const keep = new Set<number>([0, 1, count - 2, count - 1, current - 1, current, current + 1]);
  const nums = [...keep].filter((n) => n >= 0 && n < count).sort((a, b) => a - b);
  const out: (number | 'gap')[] = [];
  let prev = -1;
  for (const n of nums) {
    if (n - prev > 1) out.push('gap');
    out.push(n);
    prev = n;
  }
  return out;
}

function Pager({
  page,
  pageCount,
  onPage,
}: {
  page: number;
  pageCount: number;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <PagerArrow dir="prev" disabled={page === 0} onClick={() => onPage(page - 1)} />
      {pageItems(page, pageCount).map((it, idx) =>
        it === 'gap' ? (
          <span key={`gap-${idx}`} className="px-1 text-[11px] text-text-3">
            …
          </span>
        ) : (
          <button
            key={it}
            onClick={() => onPage(it)}
            aria-current={it === page ? 'page' : undefined}
            className={`inline-flex h-7 min-w-7 items-center justify-center rounded-md px-2 font-mono text-[11px] tabular-nums transition-colors ${
              it === page
                ? 'border border-[var(--accent-line)] bg-[var(--accent-soft)] text-up'
                : 'text-text-2 hover:bg-white/[0.04] hover:text-text-1'
            }`}
          >
            {it + 1}
          </button>
        ),
      )}
      <PagerArrow dir="next" disabled={page === pageCount - 1} onClick={() => onPage(page + 1)} />
    </div>
  );
}

function PagerArrow({
  dir,
  disabled,
  onClick,
}: {
  dir: 'prev' | 'next';
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={dir === 'prev' ? 'Previous page' : 'Next page'}
      className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 disabled:opacity-30 disabled:hover:bg-transparent"
    >
      {dir === 'prev' ? <LuChevronLeft size={14} /> : <LuChevronRight size={14} />}
    </button>
  );
}

function SortTab({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium tracking-tight transition-colors ${
        active ? 'bg-[var(--accent-soft)] text-text-1' : 'text-text-2 hover:bg-white/[0.04] hover:text-text-1'
      }`}
    >
      {label}
    </button>
  );
}

/** Scope switch (All protocol ↔ Skew traders) — a pill with an icon + an
 *  optional count badge for the Skew roster size. */
function ScopeTab({
  label,
  icon: Icon,
  active,
  onClick,
  count,
  loading,
}: {
  label: string;
  icon: IconType;
  active: boolean;
  onClick: () => void;
  count?: number;
  loading?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
        active ? 'bg-[var(--accent-soft)] text-text-1' : 'text-text-2 hover:bg-white/[0.04] hover:text-text-1'
      }`}
    >
      <Icon size={13} className={active ? 'text-accent' : 'text-text-3'} />
      {label}
      {loading ? (
        <span className="text-[10px] text-text-3">…</span>
      ) : count != null ? (
        <span className="rounded-full bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">
          {count}
        </span>
      ) : null}
    </button>
  );
}

function Stat({
  icon: Icon,
  color,
  label,
  value,
  unit,
}: {
  icon: typeof LuUsers;
  color: string;
  label: string;
  value: React.ReactNode;
  unit?: string;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-2 p-3 sm:p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={Icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className="whitespace-nowrap text-[16px] leading-none tracking-tight text-text-1 sm:text-[20px]">
        {value}
        {/* Unit is dropped on mobile (the column label carries it) so wide values
            never collide across the 3-up grid; restored from sm up. */}
        {unit && <span className="ml-1 hidden text-[11px] text-text-3 sm:inline">{unit}</span>}
      </span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={`grid ${COLS} items-center gap-2 px-4 py-3.5`}>
          <div className="ml-auto h-3 w-3 rounded bg-white/[0.04]" />
          <div className="h-3 w-32 rounded bg-white/[0.04]" />
          <div className="ml-auto h-3 w-12 rounded bg-white/[0.04]" />
          <div className="ml-auto h-3 w-14 rounded bg-white/[0.04]" />
        </div>
      ))}
    </>
  );
}

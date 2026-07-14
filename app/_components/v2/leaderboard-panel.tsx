'use client';

/**
 * V2LeaderboardPanel — Season-2 standings in the exact visual language of the
 * legacy board: trophy header, frosted totals strip, Points/Volume sort tabs,
 * the gold/silver/bronze podium, and the glass table with pagination.
 *
 * The beta indexer has no per-owner aggregation endpoint yet, so the board runs
 * on clearly-marked SAMPLE rows (lib/leaderboard/v2.ts) — banner up top, no
 * explorer/profile links on fake addresses. Wire the real hook where noted and
 * real rows take over with zero restyle.
 */
import { useState } from 'react';
import Link from 'next/link';
import type { IconType } from 'react-icons';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import {
  LuTrophy,
  LuUsers,
  LuActivity,
  LuCoins,
  LuCrown,
  LuChevronLeft,
  LuChevronRight,
  LuGlobe,
  LuSparkles,
  LuRefreshCw,
  LuArrowRight,
} from 'react-icons/lu';
import { useMounted } from '@/lib/hooks/use-mounted';
import { num, compact } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { TraderName } from '../leaderboard/trader-name';
import { useV2Leaderboard } from '@/lib/hooks/use-v2-leaderboard';
import {
  sortV2Rows,
  v2LeaderboardTotals,
  type V2LeaderboardRow,
  type V2SortKey,
} from '@/lib/leaderboard/v2';

const EXPLORER = (addr: string) => `https://suiscan.xyz/${predictV2Config.network}/account/${addr}`;
const RANK_HUE = ['#e8c14e', '#c2cbd4', '#c08a5a']; // gold / silver / bronze
const PAGE_SIZE = 25;

/** Table column template — # · Trader · Points · Volume. */
const COLS = 'grid-cols-[2rem_1fr_4.5rem_4.5rem] sm:grid-cols-[2.5rem_1fr_7rem_7rem]';

const SORT_LABEL: Record<V2SortKey, string> = { points: 'Points', volume: 'Volume' };

type Scope = 'all' | 'skew';

export function V2LeaderboardPanel() {
  const account = useCurrentAccount();
  const mounted = useMounted();
  const [sort, setSort] = useState<V2SortKey>('points');
  const [scope, setScope] = useState<Scope>('all');
  const [page, setPage] = useState(0);

  // Real Season-2 standings, reconstructed from the per-market order feeds. 'all'
  // is the whole indexed venue; 'skew' is only bets placed through the app (they
  // carry its on-chain builder code).
  const { rows: allRows, skewRows, loading, refreshing, refetch } = useV2Leaderboard();
  const rows = scope === 'skew' ? skewRows : allRows;

  function selectSort(key: V2SortKey) {
    setSort(key);
    setPage(0);
  }
  function selectScope(next: Scope) {
    setScope(next);
    setPage(0);
  }

  const sorted = sortV2Rows(rows, sort);
  const totals = v2LeaderboardTotals(rows);
  const me = mounted ? (account?.address ?? null) : null;

  // The connected wallet's standing (real rows only — sample rows never match).
  const myIndex = me ? sorted.findIndex((r) => r.owner.toLowerCase() === me.toLowerCase()) : -1;

  // Pagination — clamp in render so a shrinking dataset never strands us.
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const paginated = sorted.length > PAGE_SIZE;

  // The podium owns the top three on the first page; the table picks up from
  // rank 4 there so nobody is listed twice.
  const showPodium = safePage === 0 && sorted.length > 0;
  const podiumRows = showPodium ? sorted.slice(0, 3) : [];
  const tableStart = showPodium ? Math.min(3, sorted.length) : start;
  const pageRows = sorted.slice(tableStart, start + PAGE_SIZE);
  const pageEnd = start + (showPodium ? podiumRows.length : 0) + pageRows.length;

  return (
    <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      {/* Header */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <p className="eyebrow mb-1">Latest · Season 2</p>
          <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
            <LuTrophy size={18} className="text-accent" />
            Leaderboard
          </h1>
          <p className="mt-1 text-[12px] text-text-3">
            The new deployment starts everyone fresh · ranked by Points · {predictV2Config.network}
          </p>
        </div>
        <Link
          href="/leaderboard"
          className="group glass-inset inline-flex shrink-0 items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
        >
          Season 1 archive
          <LuArrowRight size={12} className="transition-transform duration-200 group-hover:translate-x-0.5" />
        </Link>
      </div>

      {/* Scope: the whole indexed venue vs only bets placed through the Skew app. */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <ScopeTab
          label="All traders"
          icon={LuGlobe}
          active={scope === 'all'}
          onClick={() => selectScope('all')}
          count={mounted && !loading ? allRows.length : undefined}
        />
        <ScopeTab
          label="Skew traders"
          icon={LuSparkles}
          active={scope === 'skew'}
          onClick={() => selectScope('skew')}
          count={mounted && !loading ? skewRows.length : undefined}
        />
        <button
          onClick={refetch}
          aria-label="Refresh"
          className="group glass-inset ml-auto inline-flex items-center justify-center p-1.5 text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
        >
          <LuRefreshCw size={12} className={`transition-colors duration-200 group-hover:text-accent ${refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Totals strip */}
      <div className="glass-card mb-5 grid grid-cols-3 gap-2.5 p-2.5 font-mono tabular-nums">
        <Stat icon={LuUsers} color={HUE.blue} label="Traders" value={String(totals.traders)} />
        <Stat
          icon={LuCoins}
          color={HUE.amber}
          label="Volume"
          value={
            <>
              <span className="sm:hidden">{compact(totals.volume)}</span>
              <span className="hidden sm:inline">{num(totals.volume, 2)}</span>
            </>
          }
          unit={predictV2Config.quote.symbol}
        />
        <Stat icon={LuActivity} color={HUE.teal} label="Trades" value={num(totals.trades, 0)} />
      </div>

      {/* Sort tabs */}
      <div className="mb-3 flex items-center gap-1">
        <SortTab label="Points" active={sort === 'points'} onClick={() => selectSort('points')} />
        <SortTab label="Volume" active={sort === 'volume'} onClick={() => selectSort('volume')} />
        <span className="ml-auto text-[10px] text-text-3">
          Win rate &amp; PnL on your{' '}
          <Link href="/v2/portfolio" className="underline hover:text-text-2">
            Portfolio
          </Link>
        </span>
      </div>

      {/* Podium — top three for the active ranking */}
      {showPodium && <Podium rows={podiumRows} sort={sort} me={me} />}

      {/* Connected but not on the (active-scope) board yet. */}
      {me && !loading && myIndex < 0 && <NotRankedHint scope={scope} />}

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <div
          className={`head-divider grid ${COLS} items-center gap-2 px-4 py-3 text-[10px] font-medium uppercase tracking-wider text-text-3`}
        >
          <span className="text-right">#</span>
          <span>Trader</span>
          <span className="text-right">Points</span>
          <span className="text-right">Volume</span>
        </div>

        <div className="rows-divided">
          {loading && sorted.length === 0 ? (
            <TableSkeleton />
          ) : sorted.length === 0 ? (
            <div className="px-4 py-12 text-center text-[13px] text-text-2">
              {scope === 'skew'
                ? 'No one has traded through Skew yet — bets placed in the app show up here.'
                : 'No trading activity yet — be the first name on the Season-2 board.'}
            </div>
          ) : (
            <>
              {pageRows.map((r, idx) => {
                const i = tableStart + idx;
                const isMe = me != null && r.owner.toLowerCase() === me.toLowerCase();
                return (
                  <div
                    key={r.owner}
                    className={`grid ${COLS} items-center gap-2 px-4 py-3.5 font-mono text-[12px] tabular-nums transition-colors hover:bg-white/2 ${
                      isMe ? 'bg-(--accent-soft)' : ''
                    }`}
                  >
                    <span className="text-right font-semibold text-text-3">{i + 1}</span>
                    <span className="flex min-w-0 items-center gap-2">
                      <TraderLabel row={r} isMe={isMe} />
                    </span>
                    <span className="text-right font-semibold text-accent">{num(r.points, 0)}</span>
                    <span className="text-right text-text-1">{num(r.volume, 2)}</span>
                  </div>
                );
              })}
              {paginated && (
                <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <span className="font-mono text-[11px] tabular-nums text-text-3">
                    {start + 1}–{pageEnd} <span className="text-text-2">of {sorted.length}</span> traders
                  </span>
                  <Pager page={safePage} pageCount={pageCount} onPage={setPage} />
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <p className="mt-4 text-[10px] leading-relaxed text-text-3">
        Points = liquidity (DUSDC staked) + performance (net profit, floored at zero — a loss never
        subtracts) + holding time. Season 2 counts only trades on the new release; win rate &amp;
        authoritative PnL live on your{' '}
        <Link href="/v2/portfolio" className="underline hover:text-text-2">
          Portfolio
        </Link>
        . Quote asset · {predictV2Config.quote.symbol}.
      </p>
    </div>
  );
}

/** A trader's name cell — explorer-linked, with a "you" tag for the connected wallet. */
function TraderLabel({ row, isMe }: { row: V2LeaderboardRow; isMe: boolean }) {
  return (
    <a
      href={EXPLORER(row.owner)}
      target="_blank"
      rel="noreferrer"
      className="truncate text-text-1 hover:text-accent hover:underline"
      title={row.owner}
    >
      <TraderName owner={row.owner} />
      {isMe && <span className="ml-1.5 text-[10px] text-accent">you</span>}
    </a>
  );
}

/** Connected but not on the board yet — claim a spot. */
function NotRankedHint({ scope }: { scope: Scope }) {
  return (
    <div className="glass-inset relative mb-4 flex items-center gap-2.5 overflow-hidden rounded-2xl px-4 py-3 text-[12px] text-text-2">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent"
      />
      <LuTrophy size={14} className="flex-none text-text-3" />
      {scope === 'skew'
        ? "You haven't bet through the Skew app this season yet — place one to land on the Skew board."
        : "You're connected but haven't traded this season yet — mint a position to claim your spot."}
    </div>
  );
}

/** Scope switch (All venue ↔ Skew traders) — a pill with an icon + count badge. */
function ScopeTab({
  label,
  icon: Icon,
  active,
  onClick,
  count,
}: {
  label: string;
  icon: IconType;
  active: boolean;
  onClick: () => void;
  count?: number;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
      }`}
    >
      <Icon size={13} className={active ? 'text-accent' : 'text-text-3'} />
      {label}
      {count != null && (
        <span className="rounded-full bg-bg-3 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">{count}</span>
      )}
    </button>
  );
}

function TableSkeleton() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <div key={i} className={`grid ${COLS} items-center gap-2 px-4 py-3.5`}>
          <span className="h-3 w-4 justify-self-end rounded skeleton" />
          <span className="h-4 w-32 rounded skeleton" />
          <span className="h-3 w-12 justify-self-end rounded skeleton" />
          <span className="h-3 w-12 justify-self-end rounded skeleton" />
        </div>
      ))}
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Podium — the top three for the active ranking. Winner center (gold),
 * runner-up left (silver), third right (bronze). Same podium-card glass
 * treatment as the legacy board.
 * ------------------------------------------------------------------ */
function Podium({ rows, sort, me }: { rows: V2LeaderboardRow[]; sort: V2SortKey; me: string | null }) {
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
function primaryMetric(
  row: V2LeaderboardRow,
  sort: V2SortKey,
): { value: string; unit?: string; accent: boolean } {
  if (sort === 'volume')
    return { value: num(row.volume, 2), unit: predictV2Config.quote.symbol, accent: false };
  return { value: num(row.points, 0), unit: 'pts', accent: true };
}

function PodiumCard({
  rank,
  row,
  sort,
  isMe,
  orderClass,
}: {
  rank: number;
  row: V2LeaderboardRow;
  sort: V2SortKey;
  isMe: boolean;
  orderClass?: string;
}) {
  const hue = RANK_HUE[rank];
  const champion = rank === 0;
  const m = primaryMetric(row, sort);
  const valueColor = m.accent ? 'var(--accent)' : 'var(--text-1)';

  const secondaries: { label: string; node: React.ReactNode }[] = [];
  if (sort !== 'points')
    secondaries.push({ label: 'Points', node: <span className="text-accent">{num(row.points, 0)}</span> });
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

      {/* Name — plain for sample rows, explorer-linked when real */}
      <span className="mt-3 inline-flex items-center gap-1.5 font-mono text-[12px]">
        <TraderLabel row={row} isMe={isMe} />
      </span>

      {/* Headline metric (active sort) */}
      <div className="mt-2.5 font-mono tabular-nums">
        <span
          className={champion ? 'text-[24px] leading-none' : 'text-[20px] leading-none'}
          style={{ color: valueColor }}
        >
          {m.value}
        </span>
        {m.unit && <span className="ml-1 text-[10px] text-text-3">{m.unit}</span>}
      </div>
      <span className="eyebrow mt-1.5">{SORT_LABEL[sort]}</span>

      {/* Secondary figures */}
      <div className="mt-3 flex w-full items-center justify-center gap-4 border-t border-white/5 pt-2.5 font-mono text-[11px] tabular-nums">
        {secondaries.map((s) => (
          <span key={s.label} className="flex flex-col items-center gap-0.5">
            <span className="text-[9px] uppercase tracking-wider text-text-3">{s.label}</span>
            <span className="text-text-2">{s.node}</span>
          </span>
        ))}
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

function Pager({ page, pageCount, onPage }: { page: number; pageCount: number; onPage: (p: number) => void }) {
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
                ? 'border border-(--accent-line) bg-(--accent-soft) text-up'
                : 'text-text-2 hover:bg-white/4 hover:text-text-1'
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
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
      }`}
    >
      {label}
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
        {unit && <span className="ml-1 hidden text-[11px] text-text-3 sm:inline">{unit}</span>}
      </span>
    </div>
  );
}

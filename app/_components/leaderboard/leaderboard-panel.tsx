'use client';

/**
 * Leaderboard — top traders on Predict, ranked by volume / activity / PnL.
 * Volume & trades are complete within the event window; PnL is authoritative for
 * the most active accounts (see useLeaderboard / aggregate.ts). Server-data only,
 * so it renders for any visitor; the connected wallet's row is highlighted.
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
} from 'react-icons/lu';
import { useLeaderboard, ENRICH_OWNERS } from '@/lib/hooks/use-leaderboard';
import { useMounted } from '@/lib/hooks/use-mounted';
import { sortRows, leaderboardTotals, type SortKey } from '@/lib/leaderboard/aggregate';
import { num, signed, shortId, pct } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { ErrorState } from '../ui/error-state';

const EXPLORER = (addr: string) => `https://suiscan.xyz/${predictConfig.network}/account/${addr}`;
const RANK_HUE = ['#e8c14e', '#c2cbd4', '#c08a5a']; // gold / silver / bronze
const PAGE_SIZE = 25;

export function LeaderboardPanel() {
  const { rows, baseLoading, pnlLoading, error, refetch } = useLeaderboard();
  const account = useCurrentAccount();
  const mounted = useMounted();
  const [sort, setSort] = useState<SortKey>('volume');
  const [page, setPage] = useState(0);

  // Switching the ranking reorders everything → jump back to the top page.
  function selectSort(key: SortKey) {
    setSort(key);
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

  const sorted = sortRows(rows, sort);
  const totals = leaderboardTotals(rows);
  const me = mounted ? account?.address ?? null : null;

  // Pagination — clamp the active page in render (no effect) so a shrinking
  // dataset after a refetch can never strand us on an empty page.
  const pageCount = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const pageRows = sorted.slice(start, start + PAGE_SIZE);
  const paginated = sorted.length > PAGE_SIZE;

  return (
    <div className="mx-auto w-full max-w-5xl px-5 py-6">
      {/* Header */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
            <LuTrophy size={18} className="text-[var(--accent)]" />
            Leaderboard
          </h1>
          <p className="mt-1 text-[12px] text-text-3">
            Top traders on Predict · {predictConfig.network} · live from the public event stream
          </p>
        </div>
        <button
          onClick={refetch}
          disabled={baseLoading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-line-strong px-2.5 py-1.5 text-[11px] font-medium text-text-2 transition-colors hover:border-up/40 hover:bg-up/5 hover:text-text-1 disabled:opacity-50"
        >
          <LuRefreshCw size={12} className={pnlLoading ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      {/* Totals strip */}
      <div className="glass-card mb-5 grid grid-cols-3 gap-2.5 p-2.5 font-mono tabular-nums">
        <Stat icon={LuUsers} color={HUE.blue} label="Traders" value={String(totals.traders)} />
        <Stat icon={LuCoins} color={HUE.amber} label="Volume" value={num(totals.volume, 2)} unit={predictConfig.quote.symbol} />
        <Stat icon={LuActivity} color={HUE.teal} label="Trades" value={num(totals.trades, 0)} />
      </div>

      {/* Sort tabs */}
      <div className="mb-3 flex items-center gap-1">
        <SortTab label="Volume" active={sort === 'volume'} onClick={() => selectSort('volume')} />
        <SortTab label="Trades" active={sort === 'trades'} onClick={() => selectSort('trades')} />
        <SortTab label="Win rate" active={sort === 'winrate'} onClick={() => selectSort('winrate')} />
        <SortTab label="PnL" active={sort === 'pnl'} onClick={() => selectSort('pnl')} />
        <span className="ml-auto text-[10px] text-text-3">
          Win rate &amp; PnL ranked among the {ENRICH_OWNERS} most active accounts
        </span>
      </div>

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider grid grid-cols-[2.5rem_1fr_5.5rem_4rem_5rem_6.5rem] items-center gap-2 px-4 py-2.5 text-[10px] font-medium uppercase tracking-wider text-text-3">
          <span className="text-right">#</span>
          <span>Trader</span>
          <span className="text-right">Volume</span>
          <span className="text-right">Trades</span>
          <span className="text-right">Win</span>
          <span className="text-right">PnL</span>
        </div>

        <div className="rows-divided">
        {baseLoading ? (
          <SkeletonRows />
        ) : sorted.length === 0 ? (
          <div className="px-4 py-12 text-center text-[13px] text-text-2">No trading activity yet.</div>
        ) : (
          <>
          {pageRows.map((r, idx) => {
            const i = start + idx; // global rank index (continues across pages)
            const rankColor = sort === 'volume' && i < 3 ? RANK_HUE[i] : undefined;
            const isMe = me != null && r.owner.toLowerCase() === me.toLowerCase();
            return (
              <div
                key={r.owner}
                className={`grid grid-cols-[2.5rem_1fr_5.5rem_4rem_5rem_6.5rem] items-center gap-2 px-4 py-2.5 font-mono text-[12px] tabular-nums transition-colors hover:bg-white/[0.02] ${
                  isMe ? 'bg-[var(--accent-soft)]' : ''
                }`}
              >
                <span
                  className="text-right font-semibold"
                  style={rankColor ? { color: rankColor } : { color: 'var(--text-3)' }}
                >
                  {i + 1}
                </span>
                <a
                  href={EXPLORER(r.owner)}
                  target="_blank"
                  rel="noreferrer"
                  className="truncate text-text-1 hover:text-[var(--accent)] hover:underline"
                  title={r.owner}
                >
                  {shortId(r.owner)}
                  {isMe && <span className="ml-1.5 text-[10px] text-[var(--accent)]">you</span>}
                </a>
                <span className="text-right text-text-1">{num(r.volume, 2)}</span>
                <span className="text-right text-text-2">{r.trades}</span>
                <WinCell row={r} />
                <PnlCell row={r} />
              </div>
            );
          })}
          {paginated && (
            <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <span className="font-mono text-[11px] tabular-nums text-text-3">
                {start + 1}–{start + pageRows.length}{' '}
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
        Volume = total DUSDC paid to mint and trade count are complete within the latest event window.
        PnL (realized + unrealized) is read authoritatively per&#8209;manager and summed across each
        trader&apos;s accounts. Quote asset · {predictConfig.quote.symbol}.
      </p>
    </div>
  );
}

function WinCell({ row }: { row: ReturnType<typeof sortRows>[number] }) {
  if (!row.pnlLoaded) return <span className="text-right text-text-3">…</span>;
  if (row.winRate === undefined) return <span className="text-right text-text-3">—</span>;
  return (
    <span className="text-right text-text-1">
      {pct(row.winRate, 0)}
      <span className="ml-1 text-[10px] text-text-3">·{row.decided}</span>
    </span>
  );
}

function PnlCell({ row }: { row: ReturnType<typeof sortRows>[number] }) {
  if (!row.pnlLoaded || row.totalPnl === undefined) {
    return <span className="text-right text-text-3">…</span>;
  }
  const up = row.totalPnl >= 0;
  return (
    <span className={`text-right ${up ? 'text-up' : 'text-down'}`}>{signed(row.totalPnl, 2)}</span>
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
  value: string;
  unit?: string;
}) {
  return (
    <div className="glass-inset flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={Icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className="text-[20px] leading-none tracking-tight text-text-1">
        {value}
        {unit && <span className="ml-1 text-[11px] text-text-3">{unit}</span>}
      </span>
    </div>
  );
}

function SkeletonRows() {
  return (
    <>
      {Array.from({ length: 8 }).map((_, i) => (
        <div
          key={i}
          className="grid grid-cols-[2.5rem_1fr_5.5rem_4rem_5rem_6.5rem] items-center gap-2 px-4 py-2.5"
        >
          <div className="ml-auto h-3 w-3 rounded bg-white/[0.04]" />
          <div className="h-3 w-32 rounded bg-white/[0.04]" />
          <div className="ml-auto h-3 w-12 rounded bg-white/[0.04]" />
          <div className="ml-auto h-3 w-8 rounded bg-white/[0.04]" />
          <div className="ml-auto h-3 w-10 rounded bg-white/[0.04]" />
          <div className="ml-auto h-3 w-14 rounded bg-white/[0.04]" />
        </div>
      ))}
    </>
  );
}

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
  LuCrown,
} from 'react-icons/lu';
import { useLeaderboard, ENRICH_OWNERS } from '@/lib/hooks/use-leaderboard';
import { useMounted } from '@/lib/hooks/use-mounted';
import { sortRows, leaderboardTotals, type SortKey } from '@/lib/leaderboard/aggregate';
import { num, signed, shortId, pct } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { ErrorState } from '../ui/error-state';

type Row = ReturnType<typeof sortRows>[number];

const EXPLORER = (addr: string) => `https://suiscan.xyz/${predictConfig.network}/account/${addr}`;
const RANK_HUE = ['#e8c14e', '#c2cbd4', '#c08a5a']; // gold / silver / bronze
const PAGE_SIZE = 25;

const SORT_LABEL: Record<SortKey, string> = {
  volume: 'Volume',
  trades: 'Trades',
  winrate: 'Win rate',
  pnl: 'PnL',
};

// Identicon palette — harmonized with the app's icon hues so the wallet
// jazzicons feel native to the terminal rather than a stock widget.
const JAZZ_PALETTE = ['#4dd6b0', '#6aa6e6', '#9d92e8', '#d9a94e', '#f0796b', '#5fc9c0', '#b08be0', '#e0a36a'];

/** Tiny deterministic PRNG (mulberry32) so an avatar is stable per address. */
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * WalletAvatar — a Jazzicon-style identicon rendered from the address: a base
 * fill with a few rotated, offset color shards clipped to a circle. Fully
 * deterministic (same address → same art) and allocation-free after mount.
 */
function WalletAvatar({ addr, size, ring }: { addr: string; size: number; ring: string }) {
  let seed = 0;
  for (let i = 2; i < addr.length; i++) seed = (seed * 31 + addr.charCodeAt(i)) >>> 0;
  const rng = mulberry32(seed);
  const offset = Math.floor(rng() * JAZZ_PALETTE.length);
  const palette = JAZZ_PALETTE.slice(offset).concat(JAZZ_PALETTE.slice(0, offset));

  const center = size / 2;
  const clipId = `jz-clip-${seed.toString(36)}`;
  const sheenId = `jz-sheen-${seed.toString(36)}`;
  const shapeCount = 4;
  const shards = Array.from({ length: shapeCount }, (_, i) => {
    const firstRot = rng();
    const angle = Math.PI * 2 * firstRot;
    const velocity = (size / shapeCount) * rng() + (i * size) / shapeCount;
    const tx = Math.cos(angle) * velocity;
    const ty = Math.sin(angle) * velocity;
    const rot = firstRot * 360 + rng() * 180;
    return (
      <rect
        key={i}
        width={size}
        height={size}
        fill={palette[(i + 1) % palette.length]}
        transform={`translate(${tx.toFixed(2)} ${ty.toFixed(2)}) rotate(${rot.toFixed(1)} ${center} ${center})`}
      />
    );
  });

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      aria-hidden
      style={{ borderRadius: '50%', boxShadow: `0 0 0 1px ${ring}`, display: 'block' }}
    >
      <clipPath id={clipId}>
        <circle cx={center} cy={center} r={center} />
      </clipPath>
      <g clipPath={`url(#${clipId})`}>
        <rect width={size} height={size} fill={palette[0]} />
        {shards}
        {/* soft top-light so the disc reads as a lit sphere, not a flat puck */}
        <rect width={size} height={size} fill={`url(#${sheenId})`} />
      </g>
      <defs>
        <radialGradient id={sheenId} cx="32%" cy="26%" r="75%">
          <stop offset="0%" stopColor="rgba(255,255,255,0.32)" />
          <stop offset="42%" stopColor="rgba(255,255,255,0.04)" />
          <stop offset="100%" stopColor="rgba(0,0,0,0.28)" />
        </radialGradient>
      </defs>
    </svg>
  );
}

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
  const showPodium = !baseLoading && safePage === 0 && sorted.length > 0;
  const podiumRows = showPodium ? sorted.slice(0, 3) : [];
  const tableStart = showPodium ? Math.min(3, sorted.length) : start;
  const pageRows = sorted.slice(tableStart, start + PAGE_SIZE);
  const pageEnd = start + (showPodium ? podiumRows.length : 0) + pageRows.length;

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

      {/* Podium — top three for the active ranking */}
      {showPodium && <Podium rows={podiumRows} sort={sort} me={me} />}

      {/* Your standing — placed under the podium so the connected wallet finds
          itself instantly without paging */}
      {!baseLoading && myRow ? (
        <MyRankCard rank={myIndex + 1} total={sorted.length} row={myRow} />
      ) : !baseLoading && me && sorted.length > 0 ? (
        <NotRankedHint />
      ) : null}

      {/* Table */}
      <div className="glass-card overflow-hidden">
        <div className="head-divider grid grid-cols-[2.5rem_1fr_5.5rem_4rem_5rem_6.5rem] items-center gap-2 px-4 py-3 text-[10px] font-medium uppercase tracking-wider text-text-3">
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
            const i = tableStart + idx; // global rank index (continues across pages)
            const isMe = me != null && r.owner.toLowerCase() === me.toLowerCase();
            return (
              <div
                key={r.owner}
                className={`grid grid-cols-[2.5rem_1fr_5.5rem_4rem_5rem_6.5rem] items-center gap-2 px-4 py-3.5 font-mono text-[12px] tabular-nums transition-colors hover:bg-white/[0.02] ${
                  isMe ? 'bg-[var(--accent-soft)]' : ''
                }`}
              >
                <span className="text-right font-semibold text-text-3">{i + 1}</span>
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
        Volume = total DUSDC paid to mint and trade count are complete within the latest event window.
        PnL (realized + unrealized) is read authoritatively per&#8209;manager and summed across each
        trader&apos;s accounts. Quote asset · {predictConfig.quote.symbol}.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Your standing — the connected wallet's own row, lifted out of the list
 * and pinned to the top with its live rank, so a trader never has to page
 * to find themselves. Tinted with the accent so it reads as "you".
 * ------------------------------------------------------------------ */
function MyRankCard({ rank, total, row }: { rank: number; total: number; row: Row }) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-3 rounded-2xl border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-3.5">
      <div className="flex flex-col items-center leading-none">
        <span className="eyebrow mb-1">Your rank</span>
        <span className="font-mono text-[22px] leading-none text-[var(--accent)]">#{rank}</span>
      </div>
      <WalletAvatar addr={row.owner} size={40} ring="color-mix(in srgb, var(--accent) 55%, transparent)" />
      <div className="flex flex-col gap-0.5">
        <a
          href={EXPLORER(row.owner)}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 font-mono text-[13px] text-text-1 hover:text-[var(--accent)] hover:underline"
          title={row.owner}
        >
          {shortId(row.owner)}
          <span className="text-[10px] text-[var(--accent)]">you</span>
        </a>
        <span className="font-mono text-[10px] tabular-nums text-text-3">of {total} traders</span>
      </div>
      <div className="ml-auto flex flex-wrap items-center justify-end gap-x-5 gap-y-2 font-mono tabular-nums">
        <RankStat label="Volume">
          <span className="text-text-1">{num(row.volume, 2)}</span>
          <span className="ml-1 text-[10px] text-text-3">{predictConfig.quote.symbol}</span>
        </RankStat>
        <RankStat label="Trades">
          <span className="text-text-2">{row.trades}</span>
        </RankStat>
        <RankStat label="Win">
          {!row.pnlLoaded ? (
            <span className="text-text-3">…</span>
          ) : row.winRate === undefined ? (
            <span className="text-text-3">—</span>
          ) : (
            <span className="text-text-1">{pct(row.winRate, 0)}</span>
          )}
        </RankStat>
        <RankStat label="PnL">
          {!row.pnlLoaded || row.totalPnl === undefined ? (
            <span className="text-text-3">…</span>
          ) : (
            <span className={row.totalPnl >= 0 ? 'text-up' : 'text-down'}>{signed(row.totalPnl, 2)}</span>
          )}
        </RankStat>
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
    <div className="mb-4 flex items-center gap-2.5 rounded-2xl border border-line-strong bg-white/[0.02] px-4 py-3 text-[12px] text-text-2">
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
  // Visual order left→right is 2nd · 1st · 3rd; the winner reads tallest.
  const order = [1, 0, 2].filter((i) => i < rows.length);
  return (
    <div className="mb-5 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
      {order.map((rank) => (
        <PodiumCard
          key={rows[rank].owner}
          rank={rank}
          row={rows[rank]}
          sort={sort}
          isMe={me != null && rows[rank].owner.toLowerCase() === me.toLowerCase()}
        />
      ))}
    </div>
  );
}

/** Primary metric for a podium card, following the active sort. */
function primaryMetric(row: Row, sort: SortKey): { value: string; unit?: string; tone: 'up' | 'down' | 'plain' } {
  switch (sort) {
    case 'trades':
      return { value: num(row.trades, 0), unit: 'trades', tone: 'plain' };
    case 'winrate':
      if (!row.pnlLoaded) return { value: '…', tone: 'plain' };
      if (row.winRate === undefined) return { value: '—', tone: 'plain' };
      return { value: pct(row.winRate, 0), unit: `${row.decided} decided`, tone: 'plain' };
    case 'pnl':
      if (!row.pnlLoaded || row.totalPnl === undefined) return { value: '…', tone: 'plain' };
      return {
        value: signed(row.totalPnl, 2),
        unit: predictConfig.quote.symbol,
        tone: row.totalPnl >= 0 ? 'up' : 'down',
      };
    case 'volume':
    default:
      return { value: num(row.volume, 2), unit: predictConfig.quote.symbol, tone: 'plain' };
  }
}

function PodiumCard({ rank, row, sort, isMe }: { rank: number; row: Row; sort: SortKey; isMe: boolean }) {
  const hue = RANK_HUE[rank];
  const champion = rank === 0;
  const m = primaryMetric(row, sort);
  const valueColor = m.tone === 'up' ? 'var(--up)' : m.tone === 'down' ? 'var(--down)' : 'var(--text-1)';

  // Secondary figures — the two metrics that aren't the headline.
  const secondaries: { label: string; node: React.ReactNode }[] = [];
  if (sort !== 'volume') secondaries.push({ label: 'Vol', node: num(row.volume, 2) });
  if (sort !== 'trades') secondaries.push({ label: 'Trades', node: row.trades });
  if (sort !== 'pnl')
    secondaries.push({
      label: 'PnL',
      node:
        !row.pnlLoaded || row.totalPnl === undefined ? (
          <span className="text-text-3">…</span>
        ) : (
          <span className={row.totalPnl >= 0 ? 'text-up' : 'text-down'}>{signed(row.totalPnl, 2)}</span>
        ),
    });

  return (
    <div
      className={`relative flex flex-col items-center rounded-2xl border p-4 text-center transition-transform ${
        champion ? 'sm:-translate-y-2 sm:pt-6 sm:pb-5' : ''
      }`}
      style={{
        borderColor: `color-mix(in srgb, ${hue} 32%, var(--line))`,
        background: `radial-gradient(120% 90% at 50% 0%, color-mix(in srgb, ${hue} ${
          champion ? 14 : 9
        }%, transparent), transparent 64%), color-mix(in srgb, var(--bg-1) 92%, transparent)`,
        boxShadow: champion
          ? `inset 0 1px 0 0 color-mix(in srgb, ${hue} 30%, transparent), 0 18px 44px -22px color-mix(in srgb, ${hue} 70%, transparent)`
          : 'inset 0 1px 0 0 rgba(255,255,255,0.04)',
      }}
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
        {shortId(row.owner)}
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
          className="grid grid-cols-[2.5rem_1fr_5.5rem_4rem_5rem_6.5rem] items-center gap-2 px-4 py-3.5"
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

'use client';

/**
 * FlowTape — the live order-flow heartbeat: every bet placed (mint) and cashed
 * out (redeem) across the whole protocol, newest first. A dense, quiet list (no
 * marquee — this is an instrument, per design §10.1), with a 1s clock driving
 * the relative-age column and whale bets flagged. Each row links to the trader.
 *
 * Data is server-only (the public event streams), so it renders for any visitor.
 */
import { useState } from 'react';
import Link from 'next/link';
import {
  LuArrowUp,
  LuArrowDown,
  LuFlame,
  LuActivity,
  LuRefreshCw,
  LuChevronLeft,
  LuChevronRight,
} from 'react-icons/lu';
import { useFlow } from '@/lib/hooks/use-flow';
import { useNow } from '@/lib/hooks/use-now';
import type { FlowEvent } from '@/lib/analytics/flow';
import { num, ago, ttl, shortId } from '@/lib/format';
import { WalletAvatar } from '../leaderboard/wallet-avatar';
import { ErrorState } from '../ui/error-state';

/** Row grid — kind · trader · market · price · amount · age. Tightens on mobile. */
const COLS =
  'grid-cols-[1.25rem_1fr_4.5rem_3rem] sm:grid-cols-[1.5rem_1fr_8rem_4.5rem_5rem_3rem]';

const PAGE_SIZE = 20;

export function FlowTape() {
  const { tape, whaleThreshold, loading, refreshing, error, refetch } = useFlow();
  const now = useNow(0);
  const [page, setPage] = useState(0);

  // Clamp the active page in render (no effect) so a live refetch that shrinks
  // the window can never strand the user on an empty page (same guard as the
  // leaderboard). New events prepend → page 1 always shows the newest.
  const pageCount = Math.max(1, Math.ceil(tape.length / PAGE_SIZE));
  const safePage = Math.min(page, pageCount - 1);
  const start = safePage * PAGE_SIZE;
  const pageRows = tape.slice(start, start + PAGE_SIZE);
  const paginated = tape.length > PAGE_SIZE;

  if (error) {
    return (
      <ErrorState
        title="Live flow unavailable"
        message={error}
        note="This reads the public event stream — it's usually a brief hiccup."
      />
    );
  }

  return (
    <div className="glass-card overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 head-divider px-4 py-3">
          <div className="flex items-center gap-2">
            <span className="relative flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-[var(--accent)] opacity-60" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-[var(--accent)]" />
            </span>
            <span className="text-[13px] font-semibold tracking-tight text-text-1">Live bets</span>
            <span className="eyebrow text-text-3">everyone’s bets, as they happen</span>
          </div>
          <button
            onClick={refetch}
            disabled={loading}
            className="group glass-inset inline-flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1 disabled:opacity-50"
            aria-label="Refresh"
          >
            <LuRefreshCw
              size={12}
              className={`transition-colors duration-200 group-hover:text-accent ${refreshing ? 'animate-spin' : ''}`}
            />
            Refresh
          </button>
        </div>

        {/* Column header */}
        <div className={`grid ${COLS} gap-2 px-4 py-2 text-[10px] text-text-3`}>
          <span />
          <span className="eyebrow">Trader</span>
          <span className="eyebrow hidden sm:block">Market</span>
          <span className="eyebrow hidden text-right sm:block">Price</span>
          <span className="eyebrow text-right">DUSDC</span>
          <span className="eyebrow text-right">Age</span>
        </div>

        {/* Rows */}
        {loading ? (
          <SkeletonRows />
        ) : tape.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12px] text-text-3">
            <LuActivity size={20} className="mx-auto mb-2 opacity-40" />
            No bets yet.
          </div>
        ) : (
          <div className="rows-divided">
            {pageRows.map((f) => (
              <FlowRow key={f.id} f={f} now={now} whale={f.kind === 'mint' && f.amount >= whaleThreshold} />
            ))}

            {/* Footer — range text + windowed pager. Inside rows-divided so it
                picks up the faded top hairline, matching the leaderboard. */}
            {paginated && (
              <div className="flex items-center justify-between gap-3 px-4 py-3">
                <span className="font-mono text-[11px] tabular-nums text-text-3">
                  {start + 1}–{start + pageRows.length} of {tape.length}
                </span>
                <Pager page={safePage} pageCount={pageCount} onPage={setPage} />
              </div>
            )}
          </div>
        )}
      </div>
  );
}

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

function FlowRow({ f, now, whale }: { f: FlowEvent; now: number; whale: boolean }) {
  const isUp = f.isUp;
  const Dir = isUp ? LuArrowUp : LuArrowDown;
  const isMint = f.kind === 'mint';
  return (
    <Link
      href={`/trader/${f.trader}`}
      className={`grid ${COLS} items-center gap-2 px-4 py-2 transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]`}
      title={`${isMint ? 'Bet placed' : 'Cashed out'} · ${shortId(f.trader)}`}
    >
      {/* Direction dot */}
      <span
        className={`inline-flex h-5 w-5 items-center justify-center rounded-md ${
          isUp ? 'bg-up text-bg-0' : 'bg-down text-bg-0'
        }`}
        style={{ opacity: isMint ? 1 : 0.55 }}
      >
        <Dir size={12} />
      </span>

      {/* Trader */}
      <span className="flex min-w-0 items-center gap-2">
        <WalletAvatar addr={f.trader} size={18} ring="rgba(255,255,255,0.10)" />
        <span className="truncate font-mono text-[12px] text-text-2">{shortId(f.trader)}</span>
        {whale && (
          <span
            className="inline-flex flex-none items-center gap-0.5 rounded px-1 py-px text-[9px] font-semibold text-[#d9a94e]"
            style={{ background: 'color-mix(in srgb, #d9a94e 15%, transparent)' }}
            title="One of the biggest bets right now (top 10% by size)"
          >
            <LuFlame size={9} /> BIG BET
          </span>
        )}
      </span>

      {/* Market */}
      <span className="hidden min-w-0 flex-col sm:flex">
        <span className="truncate font-mono text-[11px] text-text-2">
          {f.underlying} {num(f.strike, 0)}
        </span>
        <span className="text-[10px] text-text-3">
          {isMint ? 'placed a bet' : f.settled ? 'cashed out' : 'closed early'} · {ttl(f.expiry, now)}
        </span>
      </span>

      {/* Price */}
      <span className="hidden text-right font-mono text-[12px] tabular-nums text-text-2 sm:block">
        {num(f.price, 2)}
      </span>

      {/* Amount */}
      <span
        className={`text-right font-mono text-[12px] tabular-nums ${
          isMint ? 'text-text-1' : 'text-up'
        }`}
      >
        {isMint ? '' : '+'}
        {num(f.amount, 2)}
      </span>

      {/* Age */}
      <span className="text-right font-mono text-[11px] tabular-nums text-text-3">
        {ago(f.ts, now)}
      </span>
    </Link>
  );
}

function SkeletonRows() {
  return (
    <div className="rows-divided">
      {Array.from({ length: 10 }).map((_, i) => (
        <div key={i} className={`grid ${COLS} items-center gap-2 px-4 py-2`}>
          <span className="h-5 w-5 rounded-md skeleton" />
          <span className="flex items-center gap-2">
            <span className="h-[18px] w-[18px] rounded-full skeleton" />
            <span className="h-3 w-24 rounded skeleton" />
          </span>
          <span className="hidden h-3 w-20 rounded skeleton sm:block" />
          <span className="hidden h-3 w-10 justify-self-end rounded skeleton sm:block" />
          <span className="h-3 w-12 justify-self-end rounded skeleton" />
          <span className="h-3 w-8 justify-self-end rounded skeleton" />
        </div>
      ))}
    </div>
  );
}

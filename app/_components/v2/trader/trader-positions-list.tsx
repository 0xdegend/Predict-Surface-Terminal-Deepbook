'use client';

/**
 * V2TraderPositionsList — a trader's OPEN v2 positions (binaries + ranges),
 * read-only, marked at the current price, each with a Copy action that pre-fills
 * the trade ticket with that market and routes to /v2 (see useV2CopyTrade).
 *
 * Reuses useV2PortfolioPositions (the SAME enrichment the owner's own Portfolio
 * runs) so the figures never drift, then filters to still-open lots. Copy is
 * gated on the market still being live — not settled and not past expiry — since
 * copying a dead market would land the follower on a fallback market in the
 * ticket. Positions are read under the trader's internal account id (resolved
 * on-chain by the parent), so this works for any address, board-ranked or not.
 */
import { useMemo } from 'react';
import { LuArrowUp, LuArrowDown, LuCalendarRange, LuCopy } from 'react-icons/lu';
import { quote as fmtQuote, price, pct, signed, dateUTC } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { useV2CopyTrade } from '@/lib/hooks/use-v2-copy-trade';
import type { V2PortfolioPosition } from '@/lib/portfolio/v2';

export function V2TraderPositionsList({
  accountId,
  enabled = true,
}: {
  accountId?: string;
  enabled?: boolean;
}) {
  const { positions, isLoading } = useV2PortfolioPositions(enabled ? accountId : undefined);
  const { copyBinary, copyRange } = useV2CopyTrade();
  const now = useNow(0);

  const open = useMemo(() => positions.filter((p) => !p.settled), [positions]);
  const binaries = useMemo(() => open.filter((p) => p.direction !== 'Range'), [open]);
  const ranges = useMemo(() => open.filter((p) => p.direction === 'Range'), [open]);

  // Live = still mintable (has a market, hasn't passed expiry). A settled lot is
  // already filtered out above.
  const isLive = (p: V2PortfolioPosition) => !!p.marketId && (p.expiry == null || p.expiry > now);

  if (isLoading && positions.length === 0) return <SkeletonRows />;
  if (open.length === 0) {
    return (
      <div className="glass-inset px-4 py-12 text-center">
        <p className="text-[13px] text-text-2">No open positions right now.</p>
        <p className="mt-1 text-[12px] text-text-3">This trader has no live bets — only settled history.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {binaries.length > 0 && (
        <Section title="Binaries" count={binaries.length}>
          {binaries.map((p) => (
            <BinaryRow
              key={p.key}
              p={p}
              copyable={p.strike != null && isLive(p)}
              onCopy={() =>
                copyBinary({ marketId: p.marketId!, strike: p.strike!, isUp: p.direction === 'Up' })
              }
            />
          ))}
        </Section>
      )}
      {ranges.length > 0 && (
        <Section title="Ranges" count={ranges.length}>
          {ranges.map((p) => (
            <RangeRow
              key={p.key}
              p={p}
              copyable={p.band != null && isLive(p)}
              onCopy={() =>
                copyRange({ marketId: p.marketId!, lower: p.band!.lower, higher: p.band!.higher })
              }
            />
          ))}
        </Section>
      )}
    </div>
  );
}

/* --------------------------------- rows ---------------------------------- */

function BinaryRow({ p, copyable, onCopy }: { p: V2PortfolioPosition; copyable: boolean; onCopy: () => void }) {
  const up = p.direction === 'Up';
  return (
    <Row
      orb={
        <span className={`dir-orb scale-75 ${up ? 'up' : 'down'}`} aria-hidden>
          {up ? <LuArrowUp size={16} /> : <LuArrowDown size={16} />}
        </span>
      }
      title={
        <>
          {p.underlying ?? 'BTC'} <span className="text-text-3">{up ? '≥' : '≤'}</span>{' '}
          {p.strike != null ? price(p.strike) : '—'}
        </>
      }
      sub={`${p.expiry != null ? dateUTC(p.expiry, false) : '—'} · ${fmtQuote(p.qty)} contracts · entry ${
        p.entryPrice != null ? pct(p.entryPrice, 1) : '—'
      }`}
      mark={p.markPrice != null ? pct(p.markPrice, 1) : '—'}
      pnl={p.pnl ?? 0}
      copy={<CopyAction copyable={copyable} onCopy={onCopy} />}
    />
  );
}

function RangeRow({ p, copyable, onCopy }: { p: V2PortfolioPosition; copyable: boolean; onCopy: () => void }) {
  return (
    <Row
      orb={
        <span className="dir-orb up scale-75" aria-hidden>
          <LuCalendarRange size={15} />
        </span>
      }
      title={
        <>
          {p.underlying ?? 'BTC'} <span className="text-text-3">·</span>{' '}
          {p.band != null ? (
            <>
              {price(p.band.lower)}
              <span className="text-text-3"> — </span>
              {price(p.band.higher)}
            </>
          ) : (
            '—'
          )}
        </>
      }
      sub={`${p.expiry != null ? dateUTC(p.expiry, false) : '—'} · ${fmtQuote(p.qty)} contracts · in-band ${
        p.markPrice != null ? pct(p.markPrice, 1) : '—'
      }`}
      mark={p.markPrice != null ? pct(p.markPrice, 1) : '—'}
      pnl={p.pnl ?? 0}
      copy={<CopyAction copyable={copyable} onCopy={onCopy} />}
    />
  );
}

/**
 * Copy action: a live button while the market is tradeable, a muted "closed" tag
 * once it isn't (past expiry / no market) — matching legacy's copy gate.
 */
function CopyAction({ copyable, onCopy }: { copyable: boolean; onCopy: () => void }) {
  if (!copyable) {
    return <span className="text-[10px] uppercase tracking-wider text-text-3">closed</span>;
  }
  return (
    <button
      onClick={onCopy}
      title="Open this market in the trade ticket"
      className="inline-flex items-center gap-1.5 rounded-md border border-(--accent-line) bg-(--accent-soft) px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-up transition-colors hover:bg-up/15"
    >
      <LuCopy size={12} />
      Copy
    </button>
  );
}

/** Shared dense row layout for a binary or range position. */
function Row({
  orb,
  title,
  sub,
  mark,
  pnl,
  copy,
}: {
  orb: React.ReactNode;
  title: React.ReactNode;
  sub: string;
  mark: string;
  pnl: number;
  copy: React.ReactNode;
}) {
  const positive = pnl >= 0;
  return (
    <div className="glass-inset flex items-center gap-3 p-3 font-mono text-[12px] tabular-nums">
      {orb}
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate text-[13px] leading-none text-text-1">{title}</span>
        <span className="truncate font-sans text-[11px] text-text-2">{sub}</span>
      </div>
      <div className="flex flex-none flex-col items-end gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className="text-[9px] uppercase tracking-wider text-text-3">mark</span>
          <span className="text-[12px] text-text-1">{mark}</span>
        </span>
        <span className={`text-[12px] ${positive ? 'text-up' : 'text-down'}`}>{signed(pnl)}</span>
      </div>
      <div className="flex w-[68px] flex-none justify-end">{copy}</div>
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between">
        <h2 className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-text-2">
          <span className="h-3 w-px bg-accent/70" />
          {title}
        </h2>
        <span className="font-mono text-[11px] tabular-nums text-text-3">{count} open</span>
      </div>
      <div className="flex flex-col gap-2">{children}</div>
    </section>
  );
}

function SkeletonRows() {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="glass-inset flex items-center gap-3 p-3">
          <div className="h-8 w-8 flex-none rounded-full bg-white/[0.04]" />
          <div className="flex flex-1 flex-col gap-1.5">
            <div className="h-3 w-40 rounded bg-white/[0.04]" />
            <div className="h-2.5 w-56 rounded bg-white/[0.03]" />
          </div>
          <div className="h-3 w-12 rounded bg-white/[0.04]" />
        </div>
      ))}
    </div>
  );
}

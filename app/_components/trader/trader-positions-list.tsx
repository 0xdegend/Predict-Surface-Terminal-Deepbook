'use client';

/**
 * TraderPositionsList — a trader's OPEN positions (binaries + ranges), read-only,
 * valued at the current mark. Self-contained: owns the fetch via
 * useTraderPositions(managerIds), renders loading / empty / error, and lays the
 * positions out as dense terminal rows.
 *
 * Each row carries a "Copy" action: it pre-fills the trade ticket with this
 * market and routes to the surface (see useCopyTrade). Copy is gated on the
 * oracle still being ACTIVE — a settled/expired market isn't mintable and would
 * otherwise silently land the follower on a different market in the ticket.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { quote as fmtQuote, price, pct, signed, dateUTC } from '@/lib/format';
import { fromQuote, toFloat } from '@/config/scale';
import { positionMetrics } from '@/app/_components/positions/position-metrics';
import { useTraderPositions } from '@/lib/hooks/use-trader-positions';
import { useCopyTrade } from '@/lib/hooks/use-copy-trade';
import { getOracles, qk } from '@/lib/api/client';
import { LuArrowUp, LuArrowDown, LuCalendarRange, LuCopy } from 'react-icons/lu';
import type { PositionSummary } from '@/lib/api/types';
import type { ValuedRangePosition } from '@/lib/hooks/use-range-positions';

export function TraderPositionsList({
  managerIds,
  enabled = true,
}: {
  managerIds: string[];
  enabled?: boolean;
}) {
  const { binary, ranges, loading, error } = useTraderPositions(managerIds, enabled);
  const { copyBinary, copyRange } = useCopyTrade();

  // Which oracles are still tradeable — the copy gate. `undefined` while loading
  // so rows render a pending (not "closed") Copy state instead of flickering.
  const oraclesQ = useQuery({ queryKey: qk.oracles, queryFn: () => getOracles(), staleTime: 30_000 });
  const activeIds = useMemo(
    () =>
      oraclesQ.data
        ? new Set(oraclesQ.data.filter((o) => o.status === 'active').map((o) => o.oracle_id))
        : null,
    [oraclesQ.data],
  );
  const copyableOf = (oracleId: string): boolean | undefined =>
    activeIds == null ? undefined : activeIds.has(oracleId);

  const count = binary.length + ranges.length;

  if (error) {
    return (
      <div className="rounded-lg border border-down/40 bg-down/10 p-3 font-mono text-[12px] text-down">
        {error}
      </div>
    );
  }
  if (loading) return <SkeletonRows />;
  if (count === 0) {
    return (
      <div className="glass-inset px-4 py-12 text-center">
        <p className="text-[13px] text-text-2">No open positions right now.</p>
        <p className="mt-1 text-[12px] text-text-3">
          This trader has no live binaries or ranges — only settled history.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      {binary.length > 0 && (
        <Section title="Binaries" count={binary.length}>
          {binary.map((p) => (
            <BinaryRow
              key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
              p={p}
              copyable={copyableOf(p.oracle_id)}
              onCopy={() =>
                copyBinary({
                  oracleId: p.oracle_id,
                  expiry: p.expiry,
                  strikeScaled: String(p.strike),
                  strike: toFloat(p.strike),
                  isUp: p.is_up,
                })
              }
            />
          ))}
        </Section>
      )}
      {ranges.length > 0 && (
        <Section title="Ranges" count={ranges.length}>
          {ranges.map((p) => (
            <RangeRow
              key={`${p.oracleId}-${p.lowerStrike}-${p.higherStrike}`}
              p={p}
              copyable={copyableOf(p.oracleId)}
              onCopy={() =>
                copyRange({
                  oracleId: p.oracleId,
                  expiry: p.expiry,
                  lowerScaled: String(Math.round(p.lowerStrike)),
                  lower: toFloat(p.lowerStrike),
                  higherScaled: String(Math.round(p.higherStrike)),
                  higher: toFloat(p.higherStrike),
                })
              }
            />
          ))}
        </Section>
      )}
    </div>
  );
}

/* ------------------------------- rows -------------------------------- */

/** One open binary, valued from the server mark. */
function BinaryRow({ p, copyable, onCopy }: { p: PositionSummary; copyable?: boolean; onCopy: () => void }) {
  const m = positionMetrics(p);
  const up = p.is_up;
  return (
    <Row
      orb={
        <span className={`dir-orb scale-75 ${up ? 'up' : 'down'}`} aria-hidden>
          {up ? <LuArrowUp size={16} /> : <LuArrowDown size={16} />}
        </span>
      }
      title={
        <>
          {p.underlying_asset} <span className="text-text-3">{up ? '≥' : '≤'}</span>{' '}
          {price(toFloat(p.strike))}
        </>
      }
      sub={`${dateUTC(p.expiry, false)} · ${fmtQuote(m.contracts)} contracts · entry ${pct(m.entryPrice, 1)}`}
      mark={m.markPrice != null ? pct(m.markPrice, 1) : '—'}
      pnl={m.pnl}
      settled={m.isSettled}
      copy={<CopyAction copyable={copyable} onCopy={onCopy} />}
    />
  );
}

/** One open vertical range, valued from the live range-fair. */
function RangeRow({ p, copyable, onCopy }: { p: ValuedRangePosition; copyable?: boolean; onCopy: () => void }) {
  const contracts = fromQuote(p.openQty);
  const pnl = fromQuote(p.unrealizedPnl);
  const asset = p.underlying || 'BTC';
  return (
    <Row
      orb={
        <span className="dir-orb up scale-75" aria-hidden>
          <LuCalendarRange size={15} />
        </span>
      }
      title={
        <>
          {asset} <span className="text-text-3">·</span> {price(toFloat(p.lowerStrike))}
          <span className="text-text-3"> — </span>
          {price(toFloat(p.higherStrike))}
        </>
      }
      sub={`${dateUTC(p.expiry, false)} · ${fmtQuote(contracts)} contracts · in-band ${pct(p.fairUp, 1)}`}
      mark={pct(p.fairUp, 1)}
      pnl={pnl}
      settled={p.settled}
      copy={<CopyAction copyable={copyable} onCopy={onCopy} />}
    />
  );
}

/**
 * Copy action: a live button when the oracle is tradeable, a disabled "Copy"
 * while the oracle list is still loading, and a muted "closed" tag once we know
 * the market has settled/expired (not copyable).
 */
function CopyAction({ copyable, onCopy }: { copyable?: boolean; onCopy: () => void }) {
  if (copyable === false) {
    return <span className="text-[10px] uppercase tracking-wider text-text-3">closed</span>;
  }
  const pending = copyable === undefined;
  return (
    <button
      onClick={onCopy}
      disabled={pending}
      title={pending ? 'Checking market…' : 'Open this market in the trade ticket'}
      className="inline-flex items-center gap-1.5 rounded-md border border-[var(--accent-line)] bg-[var(--accent-soft)] px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-up transition-colors hover:bg-up/15 disabled:opacity-40"
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
  settled,
  copy,
}: {
  orb: React.ReactNode;
  title: React.ReactNode;
  sub: string;
  mark: string;
  pnl: number;
  settled: boolean;
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
          <span className="text-[9px] uppercase tracking-wider text-text-3">
            {settled ? 'settled' : 'mark'}
          </span>
          <span className="text-[12px] text-text-1">{mark}</span>
        </span>
        <span className={`text-[12px] ${positive ? 'text-up' : 'text-down'}`}>{signed(pnl)}</span>
      </div>
      <div className="flex w-[68px] flex-none justify-end">{copy}</div>
    </div>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
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
      {Array.from({ length: 5 }).map((_, i) => (
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

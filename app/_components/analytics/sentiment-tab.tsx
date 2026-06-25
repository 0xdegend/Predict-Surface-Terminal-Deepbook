'use client';

/**
 * SentimentTab — the crowd-positioning tool. The protocol-wide UP/DOWN gauge on
 * top, then the most one-sided live markets (where the crowd is most committed),
 * each tappable straight into the trade ticket. Reuses the flow + market-grid
 * spines; server-data only, renders for any visitor.
 */
import { useMemo } from 'react';
import { LuArrowUp, LuArrowDown } from 'react-icons/lu';
import { useFlow } from '@/lib/hooks/use-flow';
import { useMarketGrid } from '@/lib/hooks/use-market-grid';
import { useCopyTrade } from '@/lib/hooks/use-copy-trade';
import { useNow } from '@/lib/hooks/use-now';
import type { MarketCell } from '@/lib/analytics/market-grid';
import { compact, num, ttl } from '@/lib/format';
import { SentimentGauge } from './sentiment-gauge';

/** How many lopsided markets to surface. */
const TOP_N = 6;

export function SentimentTab() {
  const { sentiment } = useFlow();
  const { cells, loading } = useMarketGrid();
  const now = useNow(0);
  const { copyBinary } = useCopyTrade();

  // Markets with real flow, ranked by how far from a coin-flip the crowd sits.
  const lopsided = useMemo(
    () =>
      cells
        .filter((c) => c.totalCost > 0)
        .sort((a, b) => Math.abs(b.upShare - 0.5) - Math.abs(a.upShare - 0.5))
        .slice(0, TOP_N),
    [cells],
  );

  return (
    <div className="space-y-4">
      <SentimentGauge sentiment={sentiment} />

      <div className="glass-card overflow-hidden">
        <div className="border-b border-line-soft px-4 py-3">
          <div className="text-[13px] font-semibold tracking-tight text-text-1">Most one-sided markets</div>
          <div className="eyebrow mt-0.5 text-text-3">where the crowd is most committed · tap to trade</div>
        </div>

        {loading ? (
          <SkeletonRows />
        ) : lopsided.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12px] text-text-3">
            No bets on live markets yet — the crowd hasn’t taken a side.
          </div>
        ) : (
          <div className="rows-divided">
            {lopsided.map((c) => (
              <LopsidedRow key={c.oracleId} cell={c} now={now} onTrade={() => trade(c, copyBinary)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function trade(c: MarketCell, copyBinary: ReturnType<typeof useCopyTrade>['copyBinary']) {
  // Pre-fill the side the crowd is leaning (the actionable read).
  copyBinary({
    oracleId: c.oracleId,
    expiry: c.expiry,
    strikeScaled: c.atmStrikeScaled,
    strike: c.atmStrike,
    isUp: c.upShare >= 0.5,
  });
}

function LopsidedRow({ cell, now, onTrade }: { cell: MarketCell; now: number; onTrade: () => void }) {
  const leadUp = cell.upShare >= 0.5;
  const leadPct = Math.round((leadUp ? cell.upShare : 1 - cell.upShare) * 100);
  const upPct = Math.round(cell.upShare * 100);
  const Icon = leadUp ? LuArrowUp : LuArrowDown;

  return (
    <button
      onClick={onTrade}
      className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
      title={`Trade ${cell.underlying} ${leadUp ? 'UP' : 'DOWN'} · expires ${ttl(cell.expiry, now)}`}
    >
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <span className={`flex h-5 w-5 flex-none items-center justify-center rounded-md ${leadUp ? 'bg-up' : 'bg-down'} text-bg-0`}>
            <Icon size={12} />
          </span>
          <span className="font-mono text-[12px] text-text-2">
            {cell.underlying} {num(cell.forward, 0)}
          </span>
          <span className="font-mono text-[10px] tabular-nums text-text-3">{ttl(cell.expiry, now)}</span>
        </div>
        {/* split bar */}
        <div className="mt-1.5 flex h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-3">
          <div className="h-full bg-up" style={{ width: `${upPct}%` }} />
          <div className="h-full bg-down" style={{ width: `${100 - upPct}%` }} />
        </div>
      </div>
      <div className="text-right">
        <div className={`font-mono text-[13px] font-semibold tabular-nums ${leadUp ? 'text-up' : 'text-down'}`}>
          {leadPct}% {leadUp ? 'UP' : 'DN'}
        </div>
        <div className="font-mono text-[10px] tabular-nums text-text-3">{compact(cell.totalCost)} DUSDC</div>
      </div>
    </button>
  );
}

function SkeletonRows() {
  return (
    <div className="rows-divided">
      {Array.from({ length: 5 }).map((_, i) => (
        <div key={i} className="grid grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <span className="h-3 w-28 rounded bg-line-soft" />
            <span className="mt-2 block h-1.5 w-48 max-w-xs rounded-full bg-line-soft" />
          </div>
          <span className="h-4 w-16 justify-self-end rounded bg-line-soft" />
        </div>
      ))}
    </div>
  );
}

'use client';

/**
 * IvSnapshot — the Pulse "how jumpy is the market" cell: the front market's ATM
 * price-swing now + a sparkline of where it's been. A teaser for the full Price
 * swings tool.
 */
import { LuWaves } from 'react-icons/lu';
import type { MarketCell } from '@/lib/analytics/market-grid';
import { useVolHistory } from '@/lib/hooks/use-vol-history';
import { useNow } from '@/lib/hooks/use-now';
import { pct, ttl } from '@/lib/format';
import { ResponsiveSparkline } from '../charts/sparkline';

export function IvSnapshot({ market, className = '' }: { market: MarketCell | null; className?: string }) {
  const { series, loading } = useVolHistory(market ? { oracleId: market.oracleId, expiry: market.expiry } : null);
  const now = useNow(0);

  const data = series.map((p) => p.atmIv);
  const current = market?.atmIv ?? (data.length ? data[data.length - 1] : 0);

  return (
    <div className={`glass-card flex flex-col overflow-hidden ${className}`}>
      <div className="head-divider flex items-center gap-2 px-4 py-3">
        <LuWaves size={15} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-tight text-text-1">Price swing</span>
        {market && <span className="eyebrow text-text-3">{market.underlying} · ends in {ttl(market.expiry, now)}</span>}
      </div>

      <div className="flex flex-1 flex-col justify-between gap-3 p-4">
        {!market ? (
          <div className="py-6 text-center text-[12px] text-text-3">No live market.</div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[24px] font-semibold leading-none tracking-tight text-text-1">
                {pct(current, 0)}
              </span>
              <span className="text-[11px] font-medium text-text-2">expected swing</span>
            </div>
            {loading ? (
              <div className="h-8 w-full skeleton rounded" />
            ) : data.length >= 2 ? (
              <ResponsiveSparkline data={data} height={40} color="var(--accent)" />
            ) : (
              <div className="py-2 text-[11px] text-text-3">Not enough history yet.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

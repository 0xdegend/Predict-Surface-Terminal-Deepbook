'use client';

/**
 * HotMarkets — the Pulse "where the action is" panel: the most-bet live markets,
 * each a tap-to-bet row with a money-bet intensity bar + crowd lean. A compact
 * cousin of the full Markets map.
 */
import { LuFlame } from 'react-icons/lu';
import type { MarketCell } from '@/lib/analytics/market-grid';
import { compact, num, ttl } from '@/lib/format';
import { useCopyTrade } from '@/lib/hooks/use-copy-trade';
import { useNow } from '@/lib/hooks/use-now';

export function HotMarkets({ markets, loading, className = '' }: { markets: MarketCell[]; loading: boolean; className?: string }) {
  const { copyBinary } = useCopyTrade();
  const now = useNow(0);
  const max = Math.max(1, ...markets.map((m) => m.volume));

  return (
    <div className={`glass-card flex flex-col overflow-hidden ${className}`}>
      <div className="head-divider flex items-center gap-2 px-4 py-3">
        <LuFlame size={15} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-tight text-text-1">Hottest markets</span>
        <span className="eyebrow text-text-3">most bet right now</span>
      </div>

      {loading ? (
        <Skeleton />
      ) : markets.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-text-3">No live markets right now.</div>
      ) : (
        <div className="rows-divided min-h-0 flex-1 overflow-y-auto scroll-quiet">
          {markets.map((m) => {
            const leadUp = m.upShare >= 0.5;
            const hasFlow = m.volume > 0;
            return (
              <button
                key={m.oracleId}
                onClick={() =>
                  copyBinary({ oracleId: m.oracleId, expiry: m.expiry, strikeScaled: m.atmStrikeScaled, strike: m.atmStrike, isUp: leadUp })
                }
                className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-text-1">
                      {m.underlying} {num(m.forward, 0)}
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-text-3">{ttl(m.expiry, now)}</span>
                  </div>
                  <span className="mt-1 block h-1 w-full max-w-[180px] overflow-hidden rounded-full bg-bg-3">
                    <span
                      className="block h-full rounded-full bg-accent transition-[width] duration-500"
                      style={{ width: `${Math.max(hasFlow ? 4 : 0, Math.round((m.volume / max) * 100))}%`, opacity: 0.75 }}
                    />
                  </span>
                </div>
                <div className="flex-none text-right">
                  <div className="font-mono text-[12px] tabular-nums text-text-1">
                    {compact(m.volume)} <span className="text-[10px] text-text-3">DUSDC</span>
                  </div>
                  <div className={`text-[10px] font-medium ${leadUp ? 'text-up' : 'text-down'}`}>
                    {Math.round((leadUp ? m.upShare : 1 - m.upShare) * 100)}% {leadUp ? 'UP' : 'DN'}
                  </div>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Skeleton() {
  return (
    <div className="rows-divided">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-2.5">
          <div className="flex-1">
            <span className="h-3 w-24 rounded skeleton" />
            <span className="mt-2 block h-1 w-40 rounded-full skeleton" />
          </div>
          <span className="h-4 w-14 rounded skeleton" />
        </div>
      ))}
    </div>
  );
}

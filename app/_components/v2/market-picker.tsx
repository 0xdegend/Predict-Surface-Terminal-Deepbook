'use client';

/**
 * V2MarketPicker — the clickable market grid (legacy MarketPicker's role).
 * Active markets grouped by cadence; picking one drives the shared trade store,
 * which the hero smile, odds panel, and ticket all read. Live countdowns.
 */
import { useNow } from '@/lib/hooks/use-now';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { groupByCadence, CADENCE_ORDER, CADENCE_LABEL, maxLeverageX } from '@/lib/markets/v2-discovery';
import type { V2Market } from '@/lib/api/v2/types';

export function V2MarketPicker({ markets, serverNow }: { markets: V2Market[]; serverNow: number }) {
  const now = useNow(serverNow);
  const marketId = useV2TradeStore((s) => s.marketId);
  const select = useV2TradeStore((s) => s.selectMarket);
  const grouped = groupByCadence(markets);

  return (
    <div className="flex flex-col gap-5">
      {CADENCE_ORDER.map((c) =>
        grouped[c].length ? (
          <section key={c}>
            <div className="mb-2 flex items-baseline justify-between">
              <h3 className="text-[13px] font-medium tracking-tight text-text-1">{CADENCE_LABEL[c]} markets</h3>
              <span className="font-mono text-[11px] text-text-3">{grouped[c].length} live</span>
            </div>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
              {grouped[c].map((m) => (
                <Card
                  key={m.expiry_market_id}
                  market={m}
                  now={now}
                  selected={m.expiry_market_id === marketId}
                  onSelect={() => select(m.expiry_market_id)}
                />
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

function Card({
  market,
  now,
  selected,
  onSelect,
}: {
  market: V2Market;
  now: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const secs = Math.max(0, Math.round((market.expiry - now) / 1000));
  const cd = secs < 3600 ? `${Math.floor(secs / 60)}m ${secs % 60}s` : `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
  const closing = secs < 60;
  return (
    <button
      onClick={onSelect}
      className={`flex flex-col items-start gap-1 rounded-lg p-3 text-left transition-colors ${
        selected ? 'bg-(--accent-soft) text-text-1' : 'bg-white/2 text-text-2 hover:bg-white/4 hover:text-text-1'
      }`}
    >
      <span className={`font-mono text-[13px] tabular-nums ${closing ? 'text-warn' : ''}`}>{cd}</span>
      <span className="text-[10px] text-text-3">up to {maxLeverageX(market)}x</span>
    </button>
  );
}

'use client';

/**
 * The v2 Analytics tools — Pulse, Markets, Sentiment, Price swings — each a
 * full-width instrument in the legacy Analytics language (glass-card headers,
 * rows-divided lists, metric toggles). All REAL now: the market list, cadence and
 * expiry from the indexer; volume / open bets / sentiment / implied vol folded
 * from the per-market order + activity feeds and the live pricer (useV2Analytics).
 */
import { useMemo, useState } from 'react';
import { LuGrid3X3, LuArrowUp, LuArrowDown, LuWaves, LuLayoutDashboard, LuTable, LuRefreshCw } from 'react-icons/lu';
import { useQueryClient } from '@tanstack/react-query';
import { compact, num, pct, ttl } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { useV2TapToBet } from '@/lib/hooks/use-v2-tap-to-bet';
import type { Kpis, MarketCell, Sentiment, FlowRow, GridMetric } from '@/lib/analytics/v2-aggregate';
import { V2KpiStrip, V2HotMarkets, V2PriceSwing } from './pulse-widgets';
import { V2SentimentGauge } from './sentiment-gauge';
import { V2MarketTreemap } from './market-treemap';
import { V2AnalyticsMarketTable } from './market-table';
import { V2FlowTape } from './flow-tape';

/* --------------------------------- Pulse ---------------------------------- */

export function V2Pulse({
  kpis,
  cells,
  sentiment,
  flow,
}: {
  kpis: Kpis;
  cells: MarketCell[];
  sentiment: Sentiment;
  flow: FlowRow[];
}) {
  const front = cells.length ? [...cells].sort((a, b) => a.expiry - b.expiry)[0] : null;

  return (
    <div className="space-y-3">
      <V2KpiStrip kpis={kpis} />
      {/* Fixed-height "glance" row. grid-rows-1 (minmax(0,1fr)) pins the row to the
          container height and min-h-0 lets the items shrink, so the cards' own
          overflow-hidden actually clips + scrolls instead of spilling onto the
          "Latest bets" tape below. */}
      <div className="grid gap-3 lg:h-100 lg:grid-cols-3 lg:grid-rows-1">
        <div className="min-h-0 lg:col-span-2 lg:h-full">
          <V2HotMarkets cells={cells.slice(0, 8)} className="h-full" />
        </div>
        <div className="flex min-h-0 flex-col gap-3 lg:col-span-1 lg:h-full">
          <V2SentimentGauge sentiment={sentiment} className="min-h-0 flex-1" />
          <V2PriceSwing cell={front} className="min-h-0 flex-1" />
        </div>
      </div>
      <V2FlowTape rows={flow} limit={8} title="Latest bets" />
    </div>
  );
}

/* -------------------------------- Markets --------------------------------- */

const METRICS: { id: GridMetric; label: string }[] = [
  { id: 'volume', label: 'Money bet' },
  { id: 'oi', label: 'Open bets' },
  { id: 'iv', label: 'Price swing' },
  { id: 'sentiment', label: 'Sentiment' },
];

type View = 'map' | 'table';

export function V2MarketsTool({ cells }: { cells: MarketCell[] }) {
  const [metric, setMetric] = useState<GridMetric>('volume');
  const [view, setView] = useState<View>('map');
  const [refreshing, setRefreshing] = useState(false);
  const qc = useQueryClient();
  const onTrade = useV2TapToBet();

  // Manual refresh: re-fetch the per-market feeds the analytics run on (they also
  // poll on their own). Spin the icon briefly for feedback.
  const refresh = async () => {
    setRefreshing(true);
    await Promise.all([
      qc.invalidateQueries({ queryKey: ['v2', 'market'] }),
      qc.invalidateQueries({ queryKey: ['v2', 'markets'] }),
    ]);
    setTimeout(() => setRefreshing(false), 600);
  };

  return (
    <div className="glass-card overflow-hidden">
      <div className="head-divider flex flex-wrap items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-2">
          <LuGrid3X3 size={15} className="text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-text-1">Markets</span>
          <span className="eyebrow text-text-3">size = {METRICS.find((m) => m.id === metric)?.label} · color = sentiment</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex flex-wrap items-center gap-1">
            {METRICS.map((m) => (
              <button
                key={m.id}
                onClick={() => setMetric(m.id)}
                aria-pressed={metric === m.id}
                className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium tracking-tight transition-colors ${
                  metric === m.id ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
          <div className="glass-inset flex items-center gap-0.5 rounded-md p-0.5">
            <ViewBtn active={view === 'map'} onClick={() => setView('map')} icon={LuLayoutDashboard} label="Map" />
            <ViewBtn active={view === 'table'} onClick={() => setView('table')} icon={LuTable} label="Table" />
          </div>
          <button
            onClick={refresh}
            aria-label="Refresh"
            className="group glass-inset inline-flex items-center justify-center p-1.5 text-text-2 transition-all duration-200 hover:border-(--accent-line) hover:text-text-1"
          >
            <LuRefreshCw size={12} className={`transition-colors duration-200 group-hover:text-accent ${refreshing ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <div className={view === 'map' ? 'p-3' : 'pb-1'}>
        {cells.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12px] text-text-3">
            <LuGrid3X3 size={20} className="mx-auto mb-2 opacity-40" />
            No live markets right now.
          </div>
        ) : view === 'map' ? (
          <V2MarketTreemap cells={cells} metric={metric} onTrade={onTrade} />
        ) : (
          <V2AnalyticsMarketTable cells={cells} metric={metric} onTrade={onTrade} />
        )}
      </div>
    </div>
  );
}

function ViewBtn({
  active,
  onClick,
  icon: Icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof LuTable;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-3 hover:text-text-1'
      }`}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

/* ------------------------------- Sentiment -------------------------------- */

export function V2SentimentTool({ sentiment, cells }: { sentiment: Sentiment; cells: MarketCell[] }) {
  const now = useNow(0);
  const onTrade = useV2TapToBet();
  // Markets where the crowd leans hardest one way — and where there's real money
  // on it (a lopsided market with no volume isn't interesting).
  const lopsided = useMemo(
    () =>
      [...cells]
        .filter((c) => c.volume > 0)
        .sort((a, b) => Math.abs(b.upShare - 0.5) - Math.abs(a.upShare - 0.5))
        .slice(0, 6),
    [cells],
  );

  return (
    <div className="space-y-4">
      <V2SentimentGauge sentiment={sentiment} />
      <div className="glass-card overflow-hidden">
        <div className="head-divider flex items-center justify-between px-4 py-3">
          <div>
            <div className="text-[13px] font-semibold tracking-tight text-text-1">Where sentiment is strongest</div>
            <div className="eyebrow mt-0.5 text-text-3">markets most people are betting the same way · tap to bet</div>
          </div>
        </div>
        {lopsided.length === 0 ? (
          <div className="px-4 py-12 text-center text-[12px] text-text-3">No bets on the board yet.</div>
        ) : (
          <div className="rows-divided">
            {lopsided.map((c) => {
              const leadUp = c.upShare >= 0.5;
              const leadPct = Math.round((leadUp ? c.upShare : 1 - c.upShare) * 100);
              const upPct = Math.round(c.upShare * 100);
              const Icon = leadUp ? LuArrowUp : LuArrowDown;
              return (
                <button
                  key={c.marketId}
                  onClick={() => onTrade(c)}
                  title={`Trade BTC ${leadUp ? 'UP' : 'DOWN'} · ends in ${ttl(c.expiry, now)}`}
                  className="grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[color-mix(in_srgb,var(--accent)_5%,transparent)]"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`flex h-5 w-5 flex-none items-center justify-center rounded-md ${leadUp ? 'bg-up' : 'bg-down'} text-bg-0`}>
                        <Icon size={12} />
                      </span>
                      <span className="font-mono text-[12px] text-text-2">BTC {num(c.forward, 0)}</span>
                      <span className="font-mono text-[10px] tabular-nums text-text-3">{ttl(c.expiry, now)}</span>
                    </div>
                    <div className="mt-1.5 flex h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-bg-3">
                      <div className="h-full bg-up" style={{ width: `${upPct}%` }} />
                      <div className="h-full bg-down" style={{ width: `${100 - upPct}%` }} />
                    </div>
                  </div>
                  <div className="text-right">
                    <div className={`font-mono text-[13px] font-semibold tabular-nums ${leadUp ? 'text-up' : 'text-down'}`}>
                      {leadPct}% {leadUp ? 'UP' : 'DN'}
                    </div>
                    <div className="font-mono text-[10px] tabular-nums text-text-3">{compact(c.volume)} DUSDC</div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------ Price swings ------------------------------ */

export function V2VolTool({ cells }: { cells: MarketCell[] }) {
  const now = useNow(0);
  const ranked = useMemo(() => [...cells].filter((c) => c.atmIv > 0).sort((a, b) => b.atmIv - a.atmIv), [cells]);
  const max = Math.max(0.0001, ...ranked.map((c) => c.atmIv));

  return (
    <div className="glass-card overflow-hidden">
      <div className="head-divider flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <LuWaves size={15} className="text-accent" />
          <span className="text-[13px] font-semibold tracking-tight text-text-1">Price swings</span>
          <span className="eyebrow text-text-3">expected move per market · implied vol</span>
        </div>
      </div>
      {ranked.length === 0 ? (
        <div className="px-4 py-12 text-center text-[12px] text-text-3">Pricing not available right now.</div>
      ) : (
        <div className="rows-divided">
          {ranked.map((c) => (
            <div key={c.marketId} className="flex items-center gap-4 px-4 py-2.5">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[12px] text-text-1">BTC {num(c.forward, 0)}</span>
                  <span className="font-mono text-[10px] tabular-nums text-text-3">ends in {ttl(c.expiry, now)}</span>
                </div>
                <span className="mt-1.5 block h-1 w-full max-w-sm overflow-hidden rounded-full bg-bg-3">
                  <span
                    className="block h-full rounded-full bg-accent transition-[width] duration-500"
                    style={{ width: `${Math.max(4, Math.round((c.atmIv / max) * 100))}%`, opacity: 0.75 }}
                  />
                </span>
              </div>
              <span className="w-14 flex-none text-right font-mono text-[14px] font-semibold tabular-nums text-text-1">{pct(c.atmIv, 0)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

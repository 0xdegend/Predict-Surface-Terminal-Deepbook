'use client';

/**
 * Pulse widgets for the v2 Analytics dashboard — the legacy KpiStrip, HotMarkets
 * and IvSnapshot rebuilt on v2 data (real market list + cadence + expiry; sample
 * volume / sentiment / IV until the flow endpoints are indexed). Same glass /
 * head-divider / rows-divided / AnimatedNumber / Sparkline language as legacy.
 */
import { LuCoins, LuLayers, LuScale, LuFlame, LuWaves } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { compact, num, pct, ttl } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { HUE } from '@/app/_components/ui/metric';
import { AnimatedNumber } from '@/app/_components/analytics/charts/animated-number';
import { ResponsiveSparkline } from '@/app/_components/analytics/charts/sparkline';
import type { DemoKpis, DemoMarketCell } from '@/lib/api/v2/analytics-demo';
import { SampleBadge } from './sample-badge';

/* -------------------------------- KPI strip ------------------------------- */

export function V2KpiStrip({ kpis }: { kpis: DemoKpis }) {
  const upPct = Math.round(kpis.upShare * 100);
  const leadUp = kpis.upShare >= 0.5;
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Kpi icon={LuCoins} hue={HUE.amber} label="Bet · last hour" value={kpis.totalBet} format={(n) => compact(n)} unit="DUSDC" sample />
      <Kpi icon={LuLayers} hue={HUE.blue} label="Live markets" value={kpis.activeMarkets} format={(n) => String(Math.round(n))} />
      <Kpi
        icon={LuScale}
        hue={leadUp ? 'var(--up)' : 'var(--down)'}
        label="Sentiment"
        value={leadUp ? upPct : 100 - upPct}
        format={(n) => `${Math.round(n)}%`}
        unit={leadUp ? 'UP' : 'DOWN'}
        valueClass={leadUp ? 'text-up' : 'text-down'}
        sample
      />
      <Kpi icon={LuFlame} hue={HUE.coral} label="Biggest bet" value={kpis.biggestBet} format={(n) => compact(n)} unit="DUSDC" sample />
    </div>
  );
}

function Kpi({
  icon: Icon,
  hue,
  label,
  value,
  format,
  unit,
  valueClass,
  sample = false,
}: {
  icon: IconType;
  hue?: string;
  label: string;
  value: number;
  format: (n: number) => string;
  unit?: string;
  valueClass?: string;
  sample?: boolean;
}) {
  return (
    <div className="glass-inset flex items-center gap-3 p-3">
      <span
        className="inline-flex h-8 w-8 flex-none items-center justify-center rounded-lg"
        style={{ color: hue ?? 'var(--accent)', background: `color-mix(in srgb, ${hue ?? 'var(--accent)'} 14%, transparent)` }}
      >
        <Icon size={16} />
      </span>
      <div className="min-w-0">
        <div className="eyebrow flex items-center gap-1.5 text-text-3">
          {label} {sample && <SampleBadge />}
        </div>
        <div className={`font-mono text-[17px] font-semibold leading-tight tracking-tight ${valueClass ?? 'text-text-1'}`}>
          <AnimatedNumber value={value} format={format} />
          {unit && <span className="ml-1 text-[10px] font-normal text-text-3">{unit}</span>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------- hot markets ------------------------------ */

export function V2HotMarkets({ cells, className = '' }: { cells: DemoMarketCell[]; className?: string }) {
  const now = useNow(0);
  const max = Math.max(1, ...cells.map((c) => c.volume));

  return (
    <div className={`glass-card flex flex-col overflow-hidden ${className}`}>
      <div className="head-divider flex items-center gap-2 px-4 py-3">
        <LuFlame size={15} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-tight text-text-1">Hottest markets</span>
        <span className="eyebrow text-text-3">most bet right now</span>
        <span className="ml-auto">
          <SampleBadge label="Sample volume" />
        </span>
      </div>

      {cells.length === 0 ? (
        <div className="px-4 py-10 text-center text-[12px] text-text-3">No live markets right now.</div>
      ) : (
        <div className="rows-divided min-h-0 flex-1 overflow-y-auto scroll-quiet">
          {cells.map((c) => {
            const leadUp = c.upShare >= 0.5;
            return (
              <div key={c.marketId} className="flex w-full items-center gap-3 px-4 py-2.5 text-left">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[12px] text-text-1">BTC {num(c.forward, 0)}</span>
                    <span className="font-mono text-[10px] tabular-nums text-text-3">{ttl(c.expiry, now)}</span>
                  </div>
                  <span className="mt-1 block h-1 w-full max-w-[180px] overflow-hidden rounded-full bg-bg-3">
                    <span
                      className="block h-full rounded-full bg-accent transition-[width] duration-500"
                      style={{ width: `${Math.max(4, Math.round((c.volume / max) * 100))}%`, opacity: 0.75 }}
                    />
                  </span>
                </div>
                <div className="flex-none text-right">
                  <div className="font-mono text-[12px] tabular-nums text-text-1">
                    {compact(c.volume)} <span className="text-[10px] text-text-3">DUSDC</span>
                  </div>
                  <div className={`text-[10px] font-medium ${leadUp ? 'text-up' : 'text-down'}`}>
                    {Math.round((leadUp ? c.upShare : 1 - c.upShare) * 100)}% {leadUp ? 'UP' : 'DN'}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ------------------------------ price swing ------------------------------- */

export function V2PriceSwing({ cell, series, className = '' }: { cell: DemoMarketCell | null; series: number[]; className?: string }) {
  const now = useNow(0);
  const current = cell?.atmIv ?? (series.length ? series[series.length - 1] : 0);

  return (
    <div className={`glass-card flex flex-col overflow-hidden ${className}`}>
      <div className="head-divider flex items-center gap-2 px-4 py-3">
        <LuWaves size={15} className="text-accent" />
        <span className="text-[13px] font-semibold tracking-tight text-text-1">Price swing</span>
        {cell && <span className="eyebrow text-text-3">BTC · ends in {ttl(cell.expiry, now)}</span>}
        <span className="ml-auto">
          <SampleBadge />
        </span>
      </div>
      <div className="flex flex-1 flex-col justify-between gap-3 p-4">
        {!cell ? (
          <div className="py-6 text-center text-[12px] text-text-3">No live market.</div>
        ) : (
          <>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-[24px] font-semibold leading-none tracking-tight text-text-1">{pct(current, 0)}</span>
              <span className="text-[11px] font-medium text-text-2">expected swing</span>
            </div>
            {series.length >= 2 ? (
              <ResponsiveSparkline data={series} height={40} color="var(--accent)" />
            ) : (
              <div className="py-2 text-[11px] text-text-3">Not enough history yet.</div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

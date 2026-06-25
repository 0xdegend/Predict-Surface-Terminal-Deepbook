'use client';

/**
 * KpiStrip — the market-summary bar atop the Pulse dashboard. Four glance-able
 * protocol reads in a tight glass strip, with the numbers easing to new values
 * (count-up) so the bar feels live. Big tabular figures, muted labels.
 */
import { LuCoins, LuLayers, LuScale, LuFlame } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import type { AnalyticsKpis } from '@/lib/hooks/use-analytics-overview';
import { compact } from '@/lib/format';
import { HUE } from '../../ui/metric';
import { AnimatedNumber } from '../charts/animated-number';

export function KpiStrip({ kpis, loading }: { kpis: AnalyticsKpis; loading: boolean }) {
  const upPct = Math.round(kpis.upShare * 100);
  const leadUp = kpis.upShare >= 0.5;

  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
      <Kpi icon={LuCoins} hue={HUE.amber} label="Bet · last hour" value={kpis.totalBet} format={(n) => compact(n)} unit="DUSDC" loading={loading} />
      <Kpi icon={LuLayers} hue={HUE.blue} label="Live markets" value={kpis.activeMarkets} format={(n) => String(Math.round(n))} loading={loading} />
      <Kpi
        icon={LuScale}
        hue={leadUp ? 'var(--up)' : 'var(--down)'}
        label="Crowd lean"
        value={leadUp ? upPct : 100 - upPct}
        format={(n) => `${Math.round(n)}%`}
        unit={leadUp ? 'UP' : 'DOWN'}
        valueClass={leadUp ? 'text-up' : 'text-down'}
        loading={loading}
      />
      <Kpi icon={LuFlame} hue={HUE.coral} label="Biggest bet" value={kpis.biggestBet} format={(n) => compact(n)} unit="DUSDC" loading={loading} />
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
  loading,
}: {
  icon: IconType;
  hue?: string;
  label: string;
  value: number;
  format: (n: number) => string;
  unit?: string;
  valueClass?: string;
  loading: boolean;
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
        <div className="eyebrow text-text-3">{label}</div>
        {loading ? (
          <div className="mt-1 h-4 w-14 skeleton rounded" />
        ) : (
          <div className={`font-mono text-[17px] font-semibold leading-tight tracking-tight ${valueClass ?? 'text-text-1'}`}>
            <AnimatedNumber value={value} format={format} />
            {unit && <span className="ml-1 text-[10px] font-normal text-text-3">{unit}</span>}
          </div>
        )}
      </div>
    </div>
  );
}

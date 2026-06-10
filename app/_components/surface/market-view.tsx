'use client';

/**
 * MarketView — the hero viewport, switchable between the 3-D SVI vol surface
 * (the analyst view) and a live price chart (the degen view). The toggle floats
 * top-left over both; the chart bundle is lazily imported so it never loads
 * until a user opens it. Choice persists locally. Both views read the same live
 * selection, so clicking a market keeps the strike in sync across them.
 */
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { LuBoxes, LuChartArea } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useMounted } from '@/lib/hooks/use-mounted';
import { SurfaceMount } from './surface-mount';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

const PriceChart = dynamic(() => import('../chart/price-chart').then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

type View = 'surface' | 'chart';
const STORAGE_KEY = 'predict.heroView';

function readSaved(): View | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'surface' || v === 'chart' ? v : null;
  } catch {
    return null;
  }
}

export function MarketView({
  oracles,
  initialInputs,
}: {
  oracles: Oracle[];
  initialInputs: SmileInput[];
}) {
  // SSR + first paint render the default (surface); the saved choice applies
  // only after mount so hydration agrees.
  const mounted = useMounted();
  const [override, setOverride] = useState<View | null>(null);
  const view: View = override ?? (mounted ? readSaved() : null) ?? 'surface';

  function choose(next: View) {
    setOverride(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode — non-fatal */
    }
  }

  return (
    <div className="relative h-full w-full">
      {/* Floating view toggle (over both views) */}
      <div className="pointer-events-auto absolute left-3 top-3 z-20">
        <div className="segmented" role="tablist" aria-label="Market view">
          <span
            aria-hidden
            className="segmented-thumb"
            style={{ transform: view === 'chart' ? 'translateX(100%)' : 'translateX(0)' }}
          />
          <ViewTab icon={LuBoxes} label="Surface" active={view === 'surface'} onClick={() => choose('surface')} />
          <ViewTab icon={LuChartArea} label="Chart" active={view === 'chart'} onClick={() => choose('chart')} />
        </div>
      </div>

      {view === 'surface' ? (
        <SurfaceMount oracles={oracles} initialInputs={initialInputs} />
      ) : (
        <PriceChart oracles={oracles} initialInputs={initialInputs} />
      )}
    </div>
  );
}

function ViewTab({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: IconType;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        active ? 'text-text-1' : 'text-text-3 hover:text-text-2'
      }`}
    >
      <Icon size={13} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  );
}

function ChartSkeleton() {
  return (
    <div className="relative h-full w-full overflow-hidden bg-bg-0">
      <div className="absolute inset-x-8 bottom-10 top-10 animate-pulse rounded bg-[linear-gradient(180deg,rgba(77,214,176,0.10),transparent_70%)]" />
      <span className="absolute bottom-6 left-1/2 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-3">
        loading chart…
      </span>
    </div>
  );
}

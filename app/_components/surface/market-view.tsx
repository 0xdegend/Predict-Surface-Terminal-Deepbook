'use client';

/**
 * MarketView — the hero viewport, switchable between the 3-D SVI vol surface
 * (the analyst view) and a live price chart (the degen view). The toggle floats
 * top-left over both; each view's bundle is lazily imported so it only loads
 * when shown. Choice persists locally; with no saved choice the default is the
 * surface on desktop and the (much lighter) chart on mobile — so phones never
 * pull in the Three.js bundle unless the user opts into the surface. Both views
 * read the same live selection, so clicking a market keeps the strike in sync.
 */
import dynamic from 'next/dynamic';
import { useEffect, useState } from 'react';
import { LuBoxes, LuChartArea } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { SurfaceMount } from './surface-mount';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

const PriceChart = dynamic(() => import('../chart/price-chart').then((m) => m.PriceChart), {
  ssr: false,
  loading: () => <ChartSkeleton />,
});

type View = 'surface' | 'chart';
const STORAGE_KEY = 'predict.heroView';
/** Below Tailwind's `lg` we default to the chart, not the 3-D surface. */
const SMALL_SCREEN_MQ = '(max-width: 1023px)';

function readSaved(): View | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'surface' || v === 'chart' ? v : null;
  } catch {
    return null;
  }
}

/**
 * Default view when the user hasn't picked one: chart on small screens — a
 * fraction of the Three.js bundle and far friendlier on touch — surface on
 * desktop. Window-guarded so it's SSR-safe (resolves to surface on the server).
 */
function defaultView(): View {
  if (typeof window !== 'undefined' && window.matchMedia(SMALL_SCREEN_MQ).matches) {
    return 'chart';
  }
  return 'surface';
}

export function MarketView({
  oracles,
  initialInputs,
}: {
  oracles: Oracle[];
  initialInputs: SmileInput[];
}) {
  // SSR + first client render resolve to 'surface' so hydration agrees with the
  // server. Once mounted we apply the real choice: an explicit override, else a
  // saved preference, else the viewport default (chart on mobile, surface on
  // desktop). Gating the heavy view on `mounted` (below) means a phone that
  // defaults to chart never even fetches the Three.js chunk.
  const mounted = useMounted();
  const [override, setOverride] = useState<View | null>(null);
  const view: View = override ?? (mounted ? readSaved() ?? defaultView() : null) ?? 'surface';

  // Mirror the resolved view into the store so other UI (e.g. the ticket title's
  // "click surface / click a market" hint) tracks which hero is showing.
  const setHeroView = useSurfaceStore((s) => s.setHeroView);
  useEffect(() => {
    setHeroView(view);
  }, [view, setHeroView]);

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

      {/* Hold a neutral skeleton until mounted, then render the resolved view.
          This is what keeps the surface from mounting for a frame (and pulling
          in Three.js) on screens that default to the chart. */}
      {!mounted ? (
        <HeroBootSkeleton />
      ) : view === 'surface' ? (
        <SurfaceMount oracles={oracles} initialInputs={initialInputs} />
      ) : (
        <PriceChart oracles={oracles} initialInputs={initialInputs} />
      )}
    </div>
  );
}

/** Neutral pre-mount placeholder — shown for the single frame before the view
 *  resolves, so neither heavy bundle is committed until we know which to load. */
function HeroBootSkeleton() {
  return <div className="h-full w-full animate-pulse bg-bg-0" />;
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

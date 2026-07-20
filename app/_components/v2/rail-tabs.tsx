'use client';

/**
 * V2RailTabs — the rail's "Odds ⇆ Analysis" toggle, sitting under the trade
 * ticket. Two views of the same market:
 *   • Odds     — the live fair-probability curve (the surface's own read).
 *   • Analysis — the wider-market context + the picked strike's real-world read.
 *
 * Cost gate (the point of the tabs): the Analysis view is MOUNT-GATED — it isn't
 * rendered until the tab is opened, so none of its Clawby fetches fire on a
 * trader who only ever looks at the odds. The Odds view stays mounted-but-hidden
 * so its live chart keeps its state and the product tour's `svi` anchor always
 * resolves. A small dot on the Analysis tab flags that a freshly-picked strike
 * has an unseen read waiting, without the tab label itself jumping around.
 */
import { useState } from 'react';
import { LuChartSpline, LuBrain } from 'react-icons/lu';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { V2OddsPanel } from './odds-panel';
import { V2MarketAnalysis } from './btc-market-context';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

type Tab = 'odds' | 'analysis';

export function V2RailTabs({
  market,
  pricer,
  serverNow,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
}) {
  const [tab, setTab] = useState<Tab>('odds');
  const mode = useV2TradeStore((s) => s.mode);
  const strikePrice = useV2TradeStore((s) => s.strikePrice);
  // Nudge toward the Analysis tab when a binary strike is picked but unseen.
  const strikeUnseen = tab !== 'analysis' && mode === 'binary' && strikePrice != null;

  return (
    <div className="flex flex-col gap-3">
      <div className="segmented" role="tablist" aria-label="Rail view">
        <span
          aria-hidden
          className="segmented-thumb"
          style={{ transform: tab === 'analysis' ? 'translateX(100%)' : 'translateX(0)' }}
        />
        <TabButton Icon={LuChartSpline} label="Odds" active={tab === 'odds'} onClick={() => setTab('odds')} />
        <TabButton
          Icon={LuBrain}
          label="Analysis"
          active={tab === 'analysis'}
          dot={strikeUnseen}
          onClick={() => setTab('analysis')}
        />
      </div>

      {/* Odds: kept mounted (live chart state + tour anchor), hidden when inactive. */}
      <div data-tour="svi" className={tab === 'odds' ? '' : 'hidden'}>
        {market && pricer ? (
          <V2OddsPanel market={market} pricer={pricer} />
        ) : (
          <div className="card px-4 py-6 text-center text-[12px] text-text-3">Loading live odds…</div>
        )}
      </div>

      {/* Analysis: mount-gated — no Clawby fetch until the trader opens it. */}
      {tab === 'analysis' && <V2MarketAnalysis market={market} pricer={pricer} serverNow={serverNow} />}
    </div>
  );
}

function TabButton({
  Icon,
  label,
  active,
  onClick,
  dot,
}: {
  Icon: typeof LuBrain;
  label: string;
  active: boolean;
  onClick: () => void;
  dot?: boolean;
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
      {dot && (
        <span
          aria-label="new"
          className="absolute right-2 top-1.5 h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
        />
      )}
    </button>
  );
}

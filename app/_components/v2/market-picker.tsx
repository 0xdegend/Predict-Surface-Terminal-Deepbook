'use client';

/**
 * V2MarketPicker — wraps the two equivalent market views (beginner-friendly
 * cards vs the dense table) behind a segmented toggle, mirroring the legacy
 * MarketPicker. Both read the same markets + pricer seeds and drive the same
 * shared trade store, so switching is purely presentational. The choice is
 * remembered locally (own key, distinct from legacy's).
 *
 * Table is the default — traders land on the dense grid (IV / price / leverage /
 * ids at a glance); Cards stays one click away for the decision-led view.
 */
import { useState } from 'react';
import { LuLayoutGrid, LuTable2 } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useMounted } from '@/lib/hooks/use-mounted';
import { V2MarketCards } from './market-cards';
import { V2MarketTable } from './market-table';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

type View = 'cards' | 'table';
const STORAGE_KEY = 'predict.v2.marketView';

function readSaved(): View | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'cards' || v === 'table' ? v : null;
  } catch {
    return null;
  }
}

export function V2MarketPicker({
  markets,
  pricerSeeds,
  serverNow,
}: {
  markets: V2Market[];
  pricerSeeds: Record<string, LivePricer>;
  serverNow: number;
}) {
  // Server + first client paint render the default; the saved preference only
  // applies once mounted, so SSR and hydration agree. An explicit choice wins.
  const mounted = useMounted();
  const [override, setOverride] = useState<View | null>(null);
  const view: View = override ?? (mounted ? (readSaved() ?? 'table') : null) ?? 'table';

  function choose(next: View) {
    setOverride(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / storage disabled — non-fatal */
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="mb-3 flex justify-end">
        <div className="segmented" role="tablist" aria-label="Market view">
          <span
            aria-hidden
            className="segmented-thumb"
            style={{ transform: view === 'table' ? 'translateX(100%)' : 'translateX(0)' }}
          />
          <ToggleButton icon={LuLayoutGrid} label="Cards" active={view === 'cards'} onClick={() => choose('cards')} />
          <ToggleButton icon={LuTable2} label="Table" active={view === 'table'} onClick={() => choose('table')} />
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {view === 'cards' ? (
          <V2MarketCards markets={markets} pricerSeeds={pricerSeeds} serverNow={serverNow} />
        ) : (
          <V2MarketTable markets={markets} pricerSeeds={pricerSeeds} serverNow={serverNow} />
        )}
      </div>
    </div>
  );
}

function ToggleButton({
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
      className={[
        'relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        active ? 'text-text-1' : 'text-text-3 hover:text-text-2',
      ].join(' ')}
    >
      <Icon size={13} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  );
}

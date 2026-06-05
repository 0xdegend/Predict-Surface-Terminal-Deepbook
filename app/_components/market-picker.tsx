'use client';

/**
 * Market picker — wraps the two equivalent market views (beginner-friendly
 * cards vs the dense oracle table) behind a small segmented toggle. Both views
 * read the same live data and drive the same surface selection / trade ticket,
 * so switching is purely presentational. The choice is remembered locally.
 *
 * Cards is the default: it leads with the decision (UP/DOWN by an expiry) and
 * reads for non-crypto-native users; the table stays one click away for traders
 * who want IV / strike grid / oracle ids at a glance.
 */
import { useState } from 'react';
import { LuLayoutGrid, LuTable2 } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useMounted } from '@/lib/hooks/use-mounted';
import { MarketGroups } from './market-groups';
import { OracleTable } from './oracle-table';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

type View = 'cards' | 'table';
const STORAGE_KEY = 'predict.marketView';

function readSaved(): View | null {
  try {
    const v = window.localStorage.getItem(STORAGE_KEY);
    return v === 'cards' || v === 'table' ? v : null;
  } catch {
    return null;
  }
}

export function MarketPicker({
  oracles,
  inputs,
  serverNow,
}: {
  oracles: Oracle[];
  inputs: SmileInput[];
  serverNow: number;
}) {
  // Server + first client paint render the default; the saved preference only
  // applies once mounted, so SSR and hydration agree. An explicit user choice
  // overrides both.
  const mounted = useMounted();
  const [override, setOverride] = useState<View | null>(null);
  const view: View = override ?? (mounted ? readSaved() : null) ?? 'cards';

  function choose(next: View) {
    setOverride(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* private mode / storage disabled — non-fatal */
    }
  }

  return (
    <div>
      <div className="mb-3 flex justify-end">
        <div className="segmented" role="tablist" aria-label="Market view">
          {/* gliding glass thumb — sits under the labels, tracks the active tab */}
          <span
            aria-hidden
            className="segmented-thumb"
            style={{ transform: view === 'table' ? 'translateX(100%)' : 'translateX(0)' }}
          />
          <ToggleButton icon={LuLayoutGrid} label="Cards" active={view === 'cards'} onClick={() => choose('cards')} />
          <ToggleButton icon={LuTable2} label="Table" active={view === 'table'} onClick={() => choose('table')} />
        </div>
      </div>

      {view === 'cards' ? (
        <MarketGroups oracles={oracles} inputs={inputs} serverNow={serverNow} />
      ) : (
        <OracleTable oracles={oracles} inputs={inputs} serverNow={serverNow} />
      )}
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
        // relative z-10 keeps the label above the gliding thumb; flex-1 makes the
        // two segments exactly equal so translateX(100%) lands the thumb cleanly.
        'relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        active ? 'text-text-1' : 'text-text-3 hover:text-text-2',
      ].join(' ')}
    >
      <Icon size={13} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  );
}

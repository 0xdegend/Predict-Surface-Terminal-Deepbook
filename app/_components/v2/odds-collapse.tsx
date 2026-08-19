'use client';

/**
 * V2OddsCollapse — the rail's "Odds / Analysis" panel (V2RailTabs), COLLAPSED by default.
 *
 * The ticket's chance slider already answers "how likely is this", and the full
 * market-odds curve + Analysis were duplicating that 50% right below it. So they become
 * opt-in depth: a new trader isn't scrolling past a second copy of the odds on every
 * visit, and a pro is one tap from the whole picture. Collapsed also means V2RailTabs
 * isn't mounted, so its data only loads once someone actually opens it.
 */
import { useState } from 'react';
import { LuChevronDown } from 'react-icons/lu';
import { V2RailTabs } from './rail-tabs';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export function V2OddsCollapse({
  market,
  pricer,
  serverNow,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-4">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between rounded-lg border border-line px-3.5 py-2.5 text-[12px] font-medium text-text-2 transition-colors hover:border-white/20 hover:text-text-1"
      >
        <span>{open ? 'Hide market odds & analysis' : 'Market odds & analysis'}</span>
        <LuChevronDown size={16} className={`text-text-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && <V2RailTabs market={market} pricer={pricer} serverNow={serverNow} />}
    </div>
  );
}

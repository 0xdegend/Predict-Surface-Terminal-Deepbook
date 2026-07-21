'use client';

/**
 * V2VaultTabs — the vault page's left column, split into two views so the page
 * reads as a tight instrument instead of one long scroll:
 *   • Pool     — the pool's live state + your position + your pending queue.
 *   • Activity — price-per-share history + recent LP flows across all LPs.
 *
 * The deposit/withdraw rail (and crash protection) stays fixed on the right, so
 * the primary action is always in reach regardless of tab. Activity is
 * MOUNT-GATED — its server feeds (performance + fills) don't load until opened —
 * mirroring the trade rail's Odds/Analysis switch and the analytics tool bar.
 */
import { useState } from 'react';
import { LuLayers, LuActivity } from 'react-icons/lu';
import { V2VaultOverview } from './vault-overview';
import { V2VaultQueue } from './vault-queue';
import { V2VaultPerformance } from './vault-performance';
import { V2VaultActivity } from './vault-activity';

type Tab = 'pool' | 'activity';

export function V2VaultTabs() {
  const [tab, setTab] = useState<Tab>('pool');

  return (
    <div className="flex flex-col gap-5">
      <div className="segmented" role="tablist" aria-label="Vault view">
        <span
          aria-hidden
          className="segmented-thumb"
          style={{ transform: tab === 'activity' ? 'translateX(100%)' : 'translateX(0)' }}
        />
        <TabButton Icon={LuLayers} label="Pool" active={tab === 'pool'} onClick={() => setTab('pool')} />
        <TabButton Icon={LuActivity} label="Activity" active={tab === 'activity'} onClick={() => setTab('activity')} />
      </div>

      {/* Pool: kept mounted (live pool state + your queue), hidden when inactive. */}
      <div className={tab === 'pool' ? 'flex flex-col gap-5' : 'hidden'}>
        <V2VaultOverview />
        <V2VaultQueue />
      </div>

      {/* Activity: mount-gated — its indexer feeds load only when opened. */}
      {tab === 'activity' && (
        <div className="flex flex-col gap-5">
          <V2VaultPerformance />
          <V2VaultActivity />
        </div>
      )}
    </div>
  );
}

function TabButton({
  Icon,
  label,
  active,
  onClick,
}: {
  Icon: typeof LuLayers;
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

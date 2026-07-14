'use client';

/**
 * V2AnalyticsToolbar — the Analytics tool switcher for the new deployment, a
 * 1:1 match of the legacy AnalyticsToolbar (glass strip, scrollable pills,
 * accent-soft active tab, active-tool description on the right at lg+). The tool
 * set mirrors legacy — Pulse · Markets · Sentiment · Price swings · Live bets —
 * so both deployments read identically.
 */
import type { IconType } from 'react-icons';
import { LuLayoutDashboard, LuGrid3X3, LuGauge, LuWaves, LuUsers, LuActivity } from 'react-icons/lu';

export type V2AnalyticsTool = 'pulse' | 'markets' | 'sentiment' | 'vol' | 'styles' | 'flow';

export const V2_TOOLS: { id: V2AnalyticsTool; label: string; desc: string; icon: IconType }[] = [
  { id: 'pulse', label: 'Pulse', desc: 'The whole market at a glance', icon: LuLayoutDashboard },
  { id: 'markets', label: 'Markets', desc: 'Where the action is', icon: LuGrid3X3 },
  { id: 'sentiment', label: 'Sentiment', desc: 'UP vs DOWN bets', icon: LuGauge },
  { id: 'vol', label: 'Price swings', desc: 'How jumpy each market is', icon: LuWaves },
  { id: 'styles', label: 'Trader styles', desc: 'How traders bet', icon: LuUsers },
  { id: 'flow', label: 'Live bets', desc: 'Every bet as it happens', icon: LuActivity },
];

export function V2AnalyticsToolbar({
  active,
  onSelect,
}: {
  active: V2AnalyticsTool;
  onSelect: (t: V2AnalyticsTool) => void;
}) {
  const activeTool = V2_TOOLS.find((t) => t.id === active);
  return (
    <div className="glass-card mb-4 flex items-center gap-2 p-1.5">
      <div className="scroll-quiet flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {V2_TOOLS.map((t) => {
          const isActive = t.id === active;
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => onSelect(t.id)}
              aria-current={isActive ? 'page' : undefined}
              className={`inline-flex flex-none items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-medium tracking-tight transition-colors ${
                isActive ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
              }`}
            >
              <Icon size={15} className={`flex-none ${isActive ? 'text-accent' : 'text-text-3'}`} />
              {t.label}
            </button>
          );
        })}
      </div>
      <span className="hidden shrink-0 whitespace-nowrap pr-1.5 text-[11px] text-text-3 lg:block">
        {activeTool?.desc}
      </span>
    </div>
  );
}

'use client';

/**
 * AnalyticsNav — the tool switcher for the Analytics screen. A glass rail on
 * desktop (cockpit-style, §10.5) and a scrollable pill bar on mobile, sharing
 * one tool list so the two stay in lockstep. Each tool owns the full content
 * area, so the page reads one instrument at a time instead of a long scroll.
 */
import type { IconType } from 'react-icons';
import { LuLayoutDashboard, LuGrid3X3, LuGauge, LuActivity, LuWaves, LuUsers } from 'react-icons/lu';

export type AnalyticsTool = 'pulse' | 'markets' | 'sentiment' | 'vol' | 'styles' | 'flow';

export const TOOLS: { id: AnalyticsTool; label: string; desc: string; icon: IconType }[] = [
  { id: 'pulse', label: 'Pulse', desc: 'The whole market at a glance', icon: LuLayoutDashboard },
  { id: 'markets', label: 'Markets', desc: 'Where the action is', icon: LuGrid3X3 },
  { id: 'sentiment', label: 'Sentiment', desc: 'UP vs DOWN bets', icon: LuGauge },
  { id: 'vol', label: 'Price swings', desc: 'How jumpy each market is', icon: LuWaves },
  { id: 'styles', label: 'Trader styles', desc: 'How the top traders bet', icon: LuUsers },
  { id: 'flow', label: 'Live bets', desc: 'Every bet as it happens', icon: LuActivity },
];

interface NavProps {
  active: AnalyticsTool;
  onSelect: (t: AnalyticsTool) => void;
}

/**
 * A single horizontal toolbar that drives the screen on every breakpoint: a
 * full-width glass strip of tool buttons (scrollable on phones), with the active
 * tool's one-line description pinned to the right on desktop so the rail's old
 * descriptions aren't lost. Replaces the desktop sidebar so the dashboard owns
 * the full width — no left gutter, notch, or void.
 */
export function AnalyticsToolbar({ active, onSelect }: NavProps) {
  const activeTool = TOOLS.find((t) => t.id === active);
  return (
    <div className="glass-card mb-4 flex items-center gap-2 p-1.5">
      <div className="scroll-quiet flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {TOOLS.map((t) => {
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

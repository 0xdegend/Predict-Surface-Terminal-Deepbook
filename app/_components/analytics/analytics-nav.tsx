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

/** Desktop vertical rail. */
export function AnalyticsRail({ active, onSelect }: NavProps) {
  return (
    <aside className="hidden w-52 shrink-0 lg:block">
      <div className="glass-card sticky top-20 p-1.5">
        <div className="flex flex-col gap-1">
          {TOOLS.map((t) => {
            const isActive = t.id === active;
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => onSelect(t.id)}
                aria-current={isActive ? 'page' : undefined}
                className={`group relative flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
                  isActive ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
                }`}
              >
                {/* active accent rail */}
                <span
                  aria-hidden
                  className={`absolute inset-y-2 left-0 w-0.5 rounded-full bg-accent transition-opacity ${
                    isActive ? 'opacity-100' : 'opacity-0'
                  }`}
                />
                <Icon
                  size={16}
                  className={`flex-none transition-colors ${isActive ? 'text-accent' : 'text-text-3 group-hover:text-text-2'}`}
                />
                <span className="flex min-w-0 flex-col">
                  <span className="text-[12.5px] font-medium leading-tight">{t.label}</span>
                  <span className="truncate text-[10.5px] leading-tight text-text-3">{t.desc}</span>
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </aside>
  );
}

/** Mobile horizontal pill bar. */
export function AnalyticsTabs({ active, onSelect }: NavProps) {
  return (
    <div className="scroll-quiet -mx-4 mb-4 flex gap-1.5 overflow-x-auto px-4 pb-1 lg:hidden">
      {TOOLS.map((t) => {
        const isActive = t.id === active;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            aria-current={isActive ? 'page' : undefined}
            className={`inline-flex flex-none items-center gap-1.5 rounded-lg px-3 py-2 text-[12px] font-medium tracking-tight transition-colors ${
              isActive
                ? 'bg-(--accent-soft) text-text-1'
                : 'glass-inset text-text-2 hover:text-text-1'
            }`}
          >
            <Icon size={14} className={isActive ? 'text-accent' : 'text-text-3'} />
            {t.label}
          </button>
        );
      })}
    </div>
  );
}

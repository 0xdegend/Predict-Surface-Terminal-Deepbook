'use client';

/**
 * PointsTile — the trader's Points score in the account header bento. A live,
 * derived score (see lib/points/score.ts): big total on the left, a transparent
 * three-part breakdown on the right so a trader sees exactly WHY they have it.
 * Spans the full grid width as the bento's footer row.
 */
import { LuSparkles } from 'react-icons/lu';
import { num, signed } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import type { PointsBreakdown } from '@/lib/points/score';

const PARTS = [
  { key: 'liquidity', label: 'Liquidity', color: HUE.amber },
  { key: 'performance', label: 'Performance', color: HUE.teal },
  { key: 'holding', label: 'Holding', color: HUE.blue },
] as const;

export function PointsTile({ breakdown }: { breakdown: PointsBreakdown }) {
  const { total } = breakdown;

  return (
    <div className="glass-inset relative col-span-2 flex flex-col gap-4 overflow-hidden p-5 lg:col-span-3 lg:flex-row lg:items-center lg:gap-6">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 120% at 0% 0%, var(--accent-soft), transparent 55%)' }}
      />

      {/* Total */}
      <div className="relative flex flex-col gap-2 lg:w-48 lg:flex-none">
        <div className="flex items-center gap-2.5">
          <IconChip icon={LuSparkles} color={HUE.teal} size={30} />
          <span className="eyebrow">Points</span>
        </div>
        <span className="text-[34px] leading-none tracking-tight text-[var(--accent)]">{num(total, 0)}</span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">
          Live score · accrues as you trade
        </span>
      </div>

      {/* Breakdown */}
      <div className="relative flex flex-1 flex-col gap-3">
        {/* Stacked proportion meter */}
        <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
          {PARTS.map((p) => {
            const w = total > 0 ? (breakdown[p.key] / total) * 100 : 0;
            return (
              <span
                key={p.key}
                style={{ width: `${w}%`, background: p.color }}
                className="h-full first:rounded-l-full last:rounded-r-full"
              />
            );
          })}
        </div>

        {/* Legend — points + the raw figure behind each component */}
        <div className="grid grid-cols-3 gap-3">
          {PARTS.map((p) => (
            <div key={p.key} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: p.color }} />
                <span className="text-[10px] uppercase tracking-wider text-text-3">{p.label}</span>
              </div>
              <span className="font-mono text-[17px] leading-none tabular-nums text-text-1">
                {num(breakdown[p.key], 0)}
              </span>
              <span className="font-mono text-[10px] tabular-nums text-text-3">{subFigure(p.key, breakdown)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** The underlying input behind each point component, for the legend. */
function subFigure(key: (typeof PARTS)[number]['key'], b: PointsBreakdown): string {
  if (key === 'liquidity') return `${num(b.volume, 0)} ${predictConfig.quote.symbol} vol`;
  if (key === 'performance') return `${signed(b.netPnl, 0)} ${predictConfig.quote.symbol} PnL`;
  return `${num(b.avgHoldDays, 1)}d avg hold`;
}

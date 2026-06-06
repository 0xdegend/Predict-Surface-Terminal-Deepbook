'use client';

/**
 * PointsTile — the trader's live Points score as a compact stat card in the
 * account bento. A live, derived score (see lib/points/score.ts) that accrues
 * with activity; the exact per-component breakdown lives in the scoring model,
 * not the UI — here we just surface the total and what drives it.
 */
import { LuSparkles } from 'react-icons/lu';
import { num } from '@/lib/format';
import { HUE, IconChip } from '../ui/metric';

export function PointsTile({ total }: { total: number }) {
  return (
    <div className="glass-inset relative col-span-2 flex flex-col gap-2 overflow-hidden p-4 lg:col-span-1">
      {/* faint accent wash marks it as the feature stat without going full-width */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{ background: 'radial-gradient(120% 90% at 100% 0%, var(--accent-soft), transparent 60%)' }}
      />
      <div className="relative flex items-center gap-2">
        <IconChip icon={LuSparkles} color={HUE.teal} size={22} />
        <span className="eyebrow">Points</span>
      </div>
      <span className="relative text-[20px] leading-none tracking-tight text-[var(--accent)]">
        {num(total, 0)}
      </span>
      <span className="relative text-[10px] leading-relaxed text-text-3">
        Accrues from volume, performance &amp; holding time
      </span>
    </div>
  );
}

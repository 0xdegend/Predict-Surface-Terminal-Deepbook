'use client';

/**
 * TraderStyleCard — the "Trading style" panel on a trader profile. Shows the
 * derived archetype + trait tags, the one-line read, and the evidence behind it
 * (so the badge is explainable, not a black box). Reuses the profile's already-
 * fetched position/range queries — no extra network cost.
 */
import { LuSparkles } from 'react-icons/lu';
import { useTraderStyle } from '@/lib/hooks/use-trader-style';
import { num, pct } from '@/lib/format';
import { StyleBadge } from '../analytics/style-badge';

export function TraderStyleCard({ managerIds, enabled }: { managerIds: string[]; enabled: boolean }) {
  const { style, loading } = useTraderStyle(managerIds, enabled);

  return (
    <div className="glass-card mb-6 p-4">
      <div className="mb-3 flex items-center gap-2">
        <LuSparkles size={14} className="text-accent" />
        <h2 className="text-[13px] font-medium text-text-1">Trading style</h2>
      </div>

      {loading ? (
        <div className="space-y-2">
          <div className="h-7 w-40 animate-pulse rounded-md bg-line-soft/50" />
          <div className="h-3 w-56 animate-pulse rounded bg-line-soft/40" />
        </div>
      ) : !style || !style.primary ? (
        <p className="text-[12px] text-text-3">Not enough trades to read a style yet.</p>
      ) : (
        <>
          <StyleBadge style={style} />
          <p className="mt-2 text-[12px] text-text-2">{style.primary.blurb}.</p>

          {/* Evidence — the numbers behind the call. */}
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Evidence label="Avg entry" value={pct(style.stats.avgEntry, 0)} />
            <Evidence label="Longshots" value={pct(style.stats.tailShare, 0)} />
            <Evidence label="Markets" value={String(style.stats.markets)} />
            <Evidence label="Avg bet" value={`${num(style.stats.avgBet, 2)}`} unit="DUSDC" />
          </div>
        </>
      )}
    </div>
  );
}

function Evidence({ label, value, unit }: { label: string; value: string; unit?: string }) {
  return (
    <div className="glass-inset flex flex-col gap-1 p-2.5">
      <span className="eyebrow text-text-3">{label}</span>
      <span className="font-mono text-[13px] tabular-nums text-text-1">
        {value}
        {unit && <span className="ml-1 text-[10px] text-text-3">{unit}</span>}
      </span>
    </div>
  );
}

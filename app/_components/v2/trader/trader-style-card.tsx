'use client';

/**
 * V2TraderStyleCard — the "Trading style" panel on a v2 trader profile, at parity
 * with the legacy card: derived archetype + trait tags, the one-line read, and
 * the evidence numbers behind it. Runs off the trader's complete order history
 * (useV2TraderStyle), which shares the profile's already-fetched account-orders
 * query — so no extra network cost.
 */
import { LuSparkles } from 'react-icons/lu';
import { num, pct } from '@/lib/format';
import { useV2TraderStyle } from '@/lib/hooks/use-v2-trader-style';
import { predictV2Config } from '@/config/predict';
import { InfoTip } from '../../ui/info-tip';
import { StyleBadge } from '../../analytics/style-badge';

export function V2TraderStyleCard({
  accountId,
  owner,
  enabled,
}: {
  accountId?: string;
  /** The trader's wallet — the whale-immune tx-sender read key on 7-29. Shares the
   *  profile's account-orders cache, so passing it keeps every reader's queryFn
   *  identical (an account-id-only fetch would race in an empty result). */
  owner?: string;
  enabled: boolean;
}) {
  const { style, loading } = useV2TraderStyle(enabled ? accountId : undefined, owner);

  return (
    <div className="glass-card mb-6 p-4">
      <div className="mb-3 flex items-center gap-2">
        <LuSparkles size={14} className="text-accent" />
        <h2 className="text-[13px] font-medium text-text-1">Trading style</h2>
        <InfoTip label="trading style">
          A quick read of how this person tends to bet, worked out from their past bets: the kinds of
          markets they pick, how big they bet, and whether they back likely or unlikely outcomes.
        </InfoTip>
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
            <Evidence label="Avg price" value={pct(style.stats.avgEntry, 0)} />
            <Evidence label="Longshots" value={pct(style.stats.tailShare, 0)} />
            <Evidence label="Markets" value={String(style.stats.markets)} />
            <Evidence label="Avg bet" value={num(style.stats.avgBet, 2)} unit={predictV2Config.quote.symbol} />
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

'use client';

/**
 * VolRank — is implied vol high or low FOR THIS MARKET right now?
 *
 * The page has always been able to print an ATM vol. On its own that number answers
 * nothing: a trader wants to know whether it is high or low compared with what this
 * market has been doing, and that needs a history the indexer does not publish. So the
 * series is accumulated forward (lib/server/iv-store.ts) and this panel ranks today's
 * reading against it.
 *
 * The honest empty state matters more than usual here. Until the series is long enough
 * the panel says so and shows how much has been collected, rather than drawing a
 * percentile from a handful of readings, because a fake percentile is worse than an
 * absent one: it looks exactly like a real measurement.
 */
import { useIvHistory } from '@/lib/hooks/use-iv-history';
import { MIN_RANK_SAMPLES, type IvBand } from '@/lib/insights';
import { Term } from './vocab';

const BAND_TONE: Record<IvBand, string> = {
  'unusually calm': 'text-up',
  calm: 'text-up',
  normal: 'text-text-1',
  busy: 'text-down',
  'unusually busy': 'text-down',
};

export function VolRank({ enabled = true }: { enabled?: boolean }) {
  const { rank, current, samples, tenorHours, isLoading } = useIvHistory(enabled);

  if (isLoading && samples.length === 0) {
    return (
      <div className="glass rounded-lg p-4">
        <div className="h-20 animate-pulse rounded bg-white/5" />
      </div>
    );
  }

  return (
    <div className="glass rounded-lg p-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[13px] font-semibold text-text-1">
          <Term plain="Is the market jumpier than usual?" pro="ATM IV rank" />
        </h3>
        <span className="ml-auto font-mono text-[10.5px] text-text-3">{tenorHours}h tenor</span>
      </div>

      {/* The reading itself is always shown; only the RANKING waits for history. */}
      <div className="flex items-baseline gap-2.5">
        <span className={`font-mono text-[26px] tabular-nums ${rank ? BAND_TONE[rank.band] : 'text-text-1'}`}>
          {current != null ? `${Math.round(current * 100)}%` : '—'}
        </span>
        {rank && (
          <span className={`text-[12.5px] ${BAND_TONE[rank.band]}`}>
            <Term plain={PLAIN_BAND[rank.band]} pro={rank.band} />
          </span>
        )}
      </div>

      {rank ? (
        <>
          {/* Where it sits in the observed range. */}
          <div className="relative mt-3.5 h-2 rounded-full bg-white/5 shadow-[inset_0_1px_2px_rgba(0,0,0,0.35)] ring-1 ring-inset ring-white/5">
            <span
              className="absolute inset-y-0 rounded-full bg-accent/25"
              style={{ left: 0, width: `${(rank.percentile * 100).toFixed(2)}%` }}
            />
            <span
              className="absolute top-1/2 h-3.5 w-[2px] -translate-y-1/2 rounded-full bg-accent"
              style={{ left: `${(rank.percentile * 100).toFixed(2)}%` }}
            />
          </div>
          <div className="mt-1.5 flex justify-between font-mono text-[10.5px] text-text-3">
            <span>{Math.round(rank.low * 100)}% low</span>
            <span>{Math.round(rank.high * 100)}% high</span>
          </div>
          <p className="mt-2.5 text-[12px] leading-relaxed text-text-2">{rank.summary}</p>
        </>
      ) : (
        <p className="mt-3 text-[12px] leading-relaxed text-text-3">
          {samples.length === 0
            ? 'No history yet. This market has no published vol history, so we are building the record from here.'
            : `Building the record: ${samples.length} of ${MIN_RANK_SAMPLES} readings so far. The ranking turns on once there is enough to compare against.`}
        </p>
      )}
    </div>
  );
}

const PLAIN_BAND: Record<IvBand, string> = {
  'unusually calm': 'much calmer than usual',
  calm: 'calmer than usual',
  normal: 'about normal',
  busy: 'jumpier than usual',
  'unusually busy': 'much jumpier than usual',
};

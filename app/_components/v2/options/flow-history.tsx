'use client';

/**
 * FlowHistoryPanel — how the book on this expiry was built, over time.
 *
 * The page could already say what the crowd's position IS. It could not say how that
 * position arrived, and a snapshot hides the difference between a market that drifted
 * to 63% up over an hour and one that flipped there in the last ninety seconds.
 *
 * Stacked bars, up-teal over down-coral, one bar per bucket, bucket size derived from
 * the market's own life (see `flowBucketMs`) so a five-minute round and a one-week
 * expiry both get a readable chart. Empty buckets are drawn as empty rather than
 * skipped: on a market that settles in minutes, the gaps are half the information.
 */
import { compact } from '@/lib/format';
import type { FlowHistory } from '@/lib/analytics/flow-history';
import { Term } from './vocab';

const TREND_COPY: Record<string, { plain: string; pro: string; tone: string }> = {
  building: { plain: 'Picking up', pro: 'Building', tone: 'text-up' },
  steady: { plain: 'Steady', pro: 'Steady', tone: 'text-text-2' },
  fading: { plain: 'Going quiet', pro: 'Fading', tone: 'text-text-3' },
};

export function FlowHistoryPanel({ flow, isLoading }: { flow: FlowHistory; isLoading?: boolean }) {
  if (isLoading && flow.bets === 0) {
    return (
      <div className="glass rounded-lg p-4">
        <div className="h-24 animate-pulse rounded bg-white/5" />
      </div>
    );
  }

  if (flow.bets === 0) {
    return (
      <div className="glass rounded-lg p-4 text-[12.5px] leading-relaxed text-text-3">
        No bets on this expiry yet, so there is no flow to chart.
      </div>
    );
  }

  const trend = flow.trend ? TREND_COPY[flow.trend] : null;
  const span = flow.buckets.length * flow.bucketMs;

  return (
    <div className="glass rounded-lg p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <div className="font-mono text-[21px] tabular-nums text-text-1">
          ${compact(flow.stakeUsd)}
          <span className="ml-2 font-sans text-[11.5px] text-text-3">
            staked over {spanWords(span)}
          </span>
        </div>
        {trend && (
          <span className={`font-mono text-[11.5px] ${trend.tone}`}>
            <Term plain={trend.plain} pro={trend.pro} />
          </span>
        )}
      </div>

      {/* The bars. Fixed height so the panel never reflows as buckets roll over. */}
      <div className="mt-3 flex h-20 items-end gap-[3px]">
        {flow.buckets.map((b) => {
          const h = flow.peakUsd > 0 ? (b.stakeUsd / flow.peakUsd) * 100 : 0;
          const upShare = b.stakeUsd > 0 ? (b.upStakeUsd / b.stakeUsd) * 100 : 0;
          const downShare = b.stakeUsd > 0 ? (b.downStakeUsd / b.stakeUsd) * 100 : 0;
          return (
            <div
              key={b.startMs}
              className="flex h-full flex-1 flex-col justify-end"
              title={
                b.stakeUsd > 0
                  ? `$${compact(b.stakeUsd)} across ${b.bets} ${b.bets === 1 ? 'bet' : 'bets'}`
                  : 'nothing traded'
              }
            >
              {b.stakeUsd > 0 ? (
                <span
                  className="flex w-full flex-col-reverse overflow-hidden rounded-[2px]"
                  style={{ height: `${Math.max(3, h).toFixed(2)}%` }}
                >
                  <span className="w-full bg-up/70" style={{ height: `${upShare.toFixed(2)}%` }} />
                  <span className="w-full bg-down/70" style={{ height: `${downShare.toFixed(2)}%` }} />
                  <span className="w-full flex-1 bg-white/15" />
                </span>
              ) : (
                // An untraded bucket still occupies its slot, as a hairline floor.
                <span className="h-px w-full bg-white/8" />
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between font-mono text-[10.5px] text-text-3">
        <span>{bucketWords(flow.bucketMs)} per bar</span>
        <span>now</span>
      </div>

      <p className="glass-divider-top mt-3 pt-3 text-[11.5px] leading-relaxed text-text-3">
        <span className="text-up">Green</span> is money betting above a level,{' '}
        <span className="text-down">red</span> below, grey is range bets.{' '}
        {flow.traders} {flow.traders === 1 ? 'trader' : 'traders'}, {flow.bets}{' '}
        {flow.bets === 1 ? 'bet' : 'bets'}
        {flow.redeems > 0 ? `, ${flow.redeems} since closed out.` : '.'}
      </p>
    </div>
  );
}

/** "4 min", "3 hours", "2 days" — coarse on purpose, this labels an axis. */
function spanWords(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 90) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} ${h === 1 ? 'hour' : 'hours'}`;
  const d = Math.round(h / 24);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

function bucketWords(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return `${h}h`;
}

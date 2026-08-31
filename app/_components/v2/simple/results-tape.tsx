'use client';

/**
 * ResultsTape — how the last handful of rounds closed, as a row of up/down marks.
 *
 * The roulette-history pattern, and it earns its place for the same reason: a beginner
 * reads a row of marks instantly, it makes the screen feel like a live venue rather
 * than a form, and it costs no interaction at all. It is also the ONE thing on this
 * screen that is always there, including for a trader who has never bet — which is
 * what keeps the page from bottoming out into dead space.
 *
 * Deliberately NOT a prediction aid. Rounds are independent, and a tape that implied
 * otherwise would be selling a gambler's fallacy. The summary line says what happened
 * and nothing about what happens next.
 *
 * It labels the cadence it is actually showing, because that isn't always the one on
 * screen: the hourly series has no finished rounds to read (see [[use-round-history]]),
 * so it falls back rather than showing an empty box.
 */
import { useRoundHistory } from '@/lib/hooks/use-round-history';
import { upCount } from '@/lib/markets/round-history';
import { CADENCE_META } from './cadence';
import { price } from '@/lib/format';
import type { SimpleCadence } from '@/lib/markets/round-pick';

/** Enough marks to read a pattern, few enough to stay one row on a phone. */
const COUNT = 12;

export function ResultsTape({ cadence, now }: { cadence: SimpleCadence; now: number }) {
  const { cadence: shown, outcomes, loading } = useRoundHistory(cadence, now, COUNT);

  // Nothing to say yet → say nothing, rather than holding an empty frame open.
  if (!loading && outcomes.length === 0) return null;

  const ups = upCount(outcomes);
  const label = CADENCE_META[shown].short.toLowerCase();

  return (
    <section className="panel mt-5 flex flex-col gap-2.5 px-4 py-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h2 className="text-[13px] font-semibold tracking-tight text-text-1">
          How the last rounds closed
          <span className="ml-2 font-normal text-text-3">{label} rounds</span>
        </h2>
        {outcomes.length > 0 && (
          <span className="text-[11px] tabular-nums text-text-3">
            <span className="font-semibold text-text-2">{ups}</span> of the last{' '}
            <span className="font-semibold text-text-2">{outcomes.length}</span> closed higher
          </span>
        )}
      </div>

      {loading && outcomes.length === 0 ? (
        <div className="skeleton h-7 w-full rounded-lg opacity-30" />
      ) : (
        <div className="flex flex-wrap items-center gap-1.5">
          {outcomes.map((o) => (
            <span
              key={o.marketId}
              title={`Closed at ${price(o.settlement)} against a strike of ${price(o.line)}`}
              className={`flex h-7 min-w-7 items-center justify-center rounded-md border px-1.5 text-[11px] font-semibold leading-none ${
                o.up ? 'border-up/30 bg-up/10 text-up' : 'border-down/30 bg-down/10 text-down'
              }`}
            >
              <span aria-hidden="true">{o.up ? '▲' : '▼'}</span>
              <span className="sr-only">{o.up ? 'closed higher' : 'closed lower'}</span>
            </span>
          ))}
          <span className="ml-1 text-[10.5px] text-text-3">newest →</span>
        </div>
      )}
    </section>
  );
}

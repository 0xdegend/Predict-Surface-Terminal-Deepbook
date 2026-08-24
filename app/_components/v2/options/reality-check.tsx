'use client';

/**
 * RealityCheck — what the surface is pricing vs what the market has actually done.
 * Implied move against realized move over the SAME horizon, plus a plain verdict.
 * Hidden until candles load.
 *
 * HORIZON-MATCHED, not hardcoded. This used to compare a 1-HOUR implied move to a
 * 1-hour realized move no matter which expiry the page was on, which was already a
 * little loose against a 1-minute market and becomes plainly wrong the day 1-day and
 * 1-week markets ship: a week-long bet judged against the last hour of tape answers a
 * question nobody asked. The window now comes from the selected expiry's tenor band
 * (lib/insights/tenor), so both sides of the comparison always describe the same
 * stretch of time and the panel is correct for tenors that do not exist yet.
 *
 * WHY THIS SURVIVED THE PRO TRIM. It was on the cut list as a duplicate of the edge
 * scanner's per-strike implied-vs-realized column. It is not, for one reason: the
 * scanner only lists rows that clear its edge bar, and now that the bar is fee-aware
 * it is legitimately empty much of the time. Cutting this would have meant that
 * whenever nothing has an edge, the page says nothing at all about how the surface is
 * priced against reality — which is exactly the moment that fact is worth stating.
 * The scanner finds trades; this one states the regime.
 */
import type { ReactNode } from 'react';
import { realizedTenorSigma, atmIv, realizedWindowMins, tenorBand, TENOR_LABEL } from '@/lib/insights';
import { Term } from './vocab';
import type { SviFloat } from '@/lib/svi/svi';

const MINUTES_PER_YEAR = 525_600;

export function RealityCheck({
  pricer,
  expiryMs,
  now,
  closes,
}: {
  pricer: { forward: number; svi: SviFloat } | null;
  expiryMs: number | null;
  now: number;
  closes: number[] | null | undefined;
}) {
  if (!pricer || expiryMs == null) return null;

  // Both sides measured over the horizon this expiry actually spans.
  const band = tenorBand(expiryMs, now);
  const windowMins = realizedWindowMins(band);
  const realized = realizedTenorSigma(closes, windowMins);
  if (realized == null) return null;

  const impliedPct = atmIv(pricer, expiryMs, now) * Math.sqrt(windowMins / MINUTES_PER_YEAR) * 100;
  const realizedPct = realized * 100;
  const gap = impliedPct - realizedPct;
  const calmer = gap > 0.02;
  const over = TENOR_LABEL[band];

  return (
    <div className="glass rounded-lg p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-text-1">Reality check</h3>
        <span className="text-[10.5px] uppercase tracking-wide text-text-3">
          <Term plain="priced vs what actually happened" pro="implied vs realized" />
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={<Term plain="Priced move" pro="Implied move" />} value={`${impliedPct.toFixed(2)}%`} />
        <Stat label={<Term plain="Actual move" pro="Realized move" />} value={`${realizedPct.toFixed(2)}%`} tone="up" />
        <Stat label="Gap" value={`${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%`} tone={calmer ? 'down' : 'up'} />
      </div>
      {/* Name the window, so nobody has to guess what "the move" is measured over. */}
      <p className="mt-2 text-center text-[10.5px] uppercase tracking-wide text-text-3">over {over}</p>
      <p className="glass-accent mt-3 rounded-md px-3 py-2.5 text-[12.5px] leading-relaxed text-text-1">
        {calmer ? (
          <>
            BTC has been <b className="text-accent">calmer</b> than the surface is pricing. Near-the-money bets can look a
            little rich when the priced move sits above the real one.
          </>
        ) : (
          <>
            BTC has been <b className="text-accent">jumpier</b> than the surface is pricing. Bigger moves have been landing
            more often than the surface charges for.
          </>
        )}
      </p>
    </div>
  );
}

function Stat({ label, value, tone }: { label: ReactNode; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="text-center">
      <div className="text-[10.5px] uppercase tracking-wide text-text-3">{label}</div>
      <div className={`mt-1 font-mono text-[22px] tabular-nums ${tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1'}`}>{value}</div>
    </div>
  );
}

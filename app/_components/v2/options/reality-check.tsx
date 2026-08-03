'use client';

/**
 * RealityCheck — what the surface is pricing vs what the market has actually done.
 * Implied 1-hour move (from the ATM IV) against the realized 1-hour move (from the
 * recent 1-minute tape), plus a plain verdict. Hidden until candles load.
 */
import type { ReactNode } from 'react';
import { realizedTenorSigma, atmIv } from '@/lib/insights';
import { Term } from './vocab';
import type { SviFloat } from '@/lib/svi/svi';

const YEAR_HOURS = 8760;

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
  const realizedHour = realizedTenorSigma(closes, 60);
  if (realizedHour == null) return null;

  const impliedPct = atmIv(pricer, expiryMs, now) * Math.sqrt(1 / YEAR_HOURS) * 100;
  const realizedPct = realizedHour * 100;
  const gap = impliedPct - realizedPct;
  const calmer = gap > 0.02;

  return (
    <div className="glass rounded-lg p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-[13px] font-semibold text-text-1">Reality check</h3>
        <span className="text-[10.5px] uppercase tracking-wide text-text-3">
          <Term plain="priced vs what actually happened" pro="implied vs realized" />
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Stat label={<Term plain="Priced move / hour" pro="Implied 1h move" />} value={`${impliedPct.toFixed(2)}%`} />
        <Stat label={<Term plain="Actual move / hour" pro="Realized 1h move" />} value={`${realizedPct.toFixed(2)}%`} tone="up" />
        <Stat label="Gap" value={`${gap >= 0 ? '+' : ''}${gap.toFixed(2)}%`} tone={calmer ? 'down' : 'up'} />
      </div>
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

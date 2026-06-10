'use client';

/**
 * Live SVI side panel. Follows the user's surface/ticket selection (falls back
 * to the soonest non-expired market) and updates from the same live tape the
 * surface uses — `useSurfaceInputs` shares its TanStack Query cache by key, so
 * there's no second poll. Replaces the old static, server-rendered snapshot
 * that froze (and degenerated to a step as the soonest market hit expiry).
 *
 * Redesign Phase 3: presented as the "selected contract" card atop the trade
 * panel — countdown header, smile mini-chart, forward, and the raw a/b/ρ/m/σ
 * SVI params tucked behind a Model disclosure (glance vs. expand).
 */
import { useMemo } from 'react';
import { useSurfaceInputs } from './surface/use-surface-inputs';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { useNow } from '@/lib/hooks/use-now';
import { SmileStrip } from './smile-strip';
import { InfoTip } from './ui/info-tip';
import { price, num, dateUTC, countdown } from '@/lib/format';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

export function LiveSviPanel({
  oracles,
  initialInputs,
  serverNow,
}: {
  oracles: Oracle[];
  initialInputs: SmileInput[];
  serverNow: number;
}) {
  const { inputs, isLive } = useSurfaceInputs(oracles, initialInputs);
  const selection = useSurfaceStore((s) => s.selection);
  const now = useNow(serverNow);

  const shown = useMemo(() => {
    if (selection) {
      const found = inputs.find((i) => i.oracle.oracle_id === selection.oracleId);
      if (found) return { input: found, source: 'selected' as const };
    }
    const soonest = inputs.find((i) => i.oracle.expiry > now) ?? inputs[0];
    return soonest ? { input: soonest, source: 'soonest' as const } : null;
  }, [selection, inputs, now]);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="eyebrow">Market odds · {shown?.source === 'selected' ? 'selected' : 'next to expire'}</h2>
        <span className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-text-3">
          <span className={isLive ? 'live-dot' : 'h-1.5 w-1.5 rounded-full bg-text-3'} />
          {isLive ? 'live' : 'scrub'}
        </span>
      </div>

      {!shown ? (
        <div className="card mt-3 flex flex-col items-center gap-1 px-4 py-8 text-center">
          <span className="text-[12px] text-text-2">No market selected</span>
          <span className="text-[11px] text-text-3">Tap a point on the surface to load it here.</span>
        </div>
      ) : (
        <Body input={shown.input} now={now} />
      )}
    </div>
  );
}

function Body({ input, now }: { input: SmileInput; now: number }) {
  const { oracle, svi, forward } = input;
  const asset = oracle.underlying_asset;
  const msLeft = oracle.expiry - now;
  const expired = msLeft <= 0;
  const rows: { name: string; symbol: string; value: string; desc: string }[] = [
    {
      name: 'Base uncertainty',
      symbol: 'a',
      value: num(svi.a, 6),
      desc: 'Overall height of the curve — how much uncertainty is priced in before any tilt.',
    },
    {
      name: 'Wing steepness',
      symbol: 'b',
      value: num(svi.b, 6),
      desc: 'How fast the odds bend on big moves. Higher = large moves seen as more likely.',
    },
    {
      name: 'Tilt',
      symbol: 'ρ',
      value: num(svi.rho, 6),
      desc: `Which way the curve leans. Negative = more worry about ${asset} falling than rising.`,
    },
    {
      name: 'Center shift',
      symbol: 'm',
      value: num(svi.m, 6),
      desc: 'Where the calmest point sits vs. the expected price. Near zero = right at it.',
    },
    {
      name: 'Curve sharpness',
      symbol: 'σ',
      value: num(svi.sigma, 6),
      desc: 'How sharp the bottom is — how fast odds bend away from the expected price.',
    },
  ];

  return (
    <div className="card mt-3 p-3.5">
      {/* Contract header */}
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[13px] font-medium tracking-tight text-text-1">
          {oracle.underlying_asset} · {dateUTC(oracle.expiry)}
        </span>
        <span
          className={`font-mono text-[11px] tabular-nums ${expired ? 'text-down' : 'text-text-2'}`}
        >
          {expired ? 'expired' : `${countdown(oracle.expiry, now)} left`}
        </span>
      </div>

      <div className="mt-3">
        <SmileStrip input={input} />
      </div>

      {expired && (
        <p className="mt-2 text-[10px] leading-relaxed text-text-3">
          This market is at expiry — with no time left, the odds collapse to a hard yes/no at the
          current price. Pick a later expiry on the surface for a full curve.
        </p>
      )}

      {/* Expected price — the one number that matters at a glance */}
      <div className="glass-divider-top mt-3 flex items-baseline justify-between pt-3">
        <span className="inline-flex items-center gap-1">
          <span className="eyebrow">Expected price at expiry</span>
          <InfoTip label="expected price at expiry">
            {`Where the market expects ${asset} to land at expiry (today's price carried forward). Right here, ending higher or lower is close to a coin flip.`}
          </InfoTip>
        </span>
        <span className="font-mono text-[15px] tabular-nums text-text-1">{price(forward)}</span>
      </div>

      {/* Raw SVI params — for quants, behind a disclosure */}
      <details className="group mt-1">
        <summary className="flex cursor-pointer list-none items-center justify-between py-2 text-text-3 transition-colors hover:text-text-2 [&::-webkit-details-marker]:hidden">
          <span className="inline-flex items-center gap-1">
            <span className="eyebrow">Advanced · pricing model</span>
            <InfoTip label="pricing model (SVI)">
              SVI is the volatility model the protocol prices with. These five numbers define the
              whole odds curve — for traders who want the raw parameters.
            </InfoTip>
          </span>
          <svg
            className="transition-transform duration-150 group-open:rotate-180"
            width="10"
            height="10"
            viewBox="0 0 10 10"
            fill="none"
          >
            <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
          </svg>
        </summary>
        <div className="mt-1 grid grid-cols-1 gap-px overflow-hidden rounded-md bg-[var(--line-soft)]">
          {rows.map((r) => (
            <div key={r.symbol} className="bg-[var(--bg-2)] px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <span className="inline-flex items-baseline gap-1.5">
                  <span className="text-[11px] text-text-2">{r.name}</span>
                  <span className="font-mono text-[10px] text-text-3">{r.symbol}</span>
                </span>
                <span className="font-mono text-[11px] tabular-nums text-text-1">{r.value}</span>
              </div>
              <p className="mt-0.5 text-[10px] leading-snug text-text-3">{r.desc}</p>
            </div>
          ))}
        </div>
      </details>
    </div>
  );
}

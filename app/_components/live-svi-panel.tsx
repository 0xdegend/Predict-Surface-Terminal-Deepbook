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
import { price, dateUTC, countdown } from '@/lib/format';
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
  const { oracle, forward } = input;
  const asset = oracle.underlying_asset;
  const msLeft = oracle.expiry - now;
  const expired = msLeft <= 0;

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
    </div>
  );
}

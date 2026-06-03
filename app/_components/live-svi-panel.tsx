'use client';

/**
 * Live SVI side panel. Follows the user's surface/ticket selection (falls back
 * to the soonest non-expired market) and updates from the same live tape the
 * surface uses — `useSurfaceInputs` shares its TanStack Query cache by key, so
 * there's no second poll. Replaces the old static, server-rendered snapshot
 * that froze (and degenerated to a step as the soonest market hit expiry).
 */
import { useMemo } from 'react';
import { useSurfaceInputs } from './surface/use-surface-inputs';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { useNow } from '@/lib/hooks/use-now';
import { SmileStrip } from './smile-strip';
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
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-[#8B9099]">
          SVI · {shown?.source === 'selected' ? 'selected' : 'soonest expiry'}
        </h2>
        <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-[#5A5F66]">
          <span className={`h-1.5 w-1.5 rounded-full ${isLive ? 'animate-pulse bg-up' : 'bg-[#5A5F66]'}`} />
          {isLive ? 'live' : 'scrub'}
        </span>
      </div>

      {!shown ? (
        <p className="mt-3 text-[12px] text-[#5A5F66]">No live SVI snapshot yet.</p>
      ) : (
        <Body input={shown.input} now={now} />
      )}
    </div>
  );
}

function Body({ input, now }: { input: SmileInput; now: number }) {
  const { oracle, svi, forward } = input;
  const expired = oracle.expiry - now <= 0;
  const rows: [string, string][] = [
    ['a', num(svi.a, 6)],
    ['b', num(svi.b, 6)],
    ['ρ (rho)', num(svi.rho, 6)],
    ['m', num(svi.m, 6)],
    ['σ (sigma)', num(svi.sigma, 6)],
  ];

  return (
    <>
      <div className="mt-2 flex items-baseline justify-between font-mono text-[10px] tracking-wider text-[#5A5F66]">
        <span>
          {oracle.underlying_asset} · {dateUTC(oracle.expiry)}
        </span>
        <span className={expired ? 'text-down' : 'text-[#8B9099]'}>
          {expired ? 'expired' : `${countdown(oracle.expiry, now)} left`}
        </span>
      </div>

      <div className="mt-3">
        <SmileStrip input={input} />
      </div>

      {expired && (
        <p className="mt-2 text-[10px] leading-relaxed text-[#5A5F66]">
          This market is at expiry — with no time left, the smile collapses to a step at the
          forward. Pick a later expiry on the surface for a full curve.
        </p>
      )}

      <div className="mt-3 font-mono text-[12px] tabular-nums">
        <div className="mb-3 flex items-baseline justify-between border-b border-white/[0.05] pb-2">
          <span className="text-[10px] uppercase tracking-wider text-[#5A5F66]">Forward</span>
          <span className="text-[#E6E8EB]">{price(forward)}</span>
        </div>
        {rows.map(([k, v]) => (
          <div key={k} className="flex items-baseline justify-between py-1">
            <span className="text-[#8B9099]">{k}</span>
            <span className="text-[#E6E8EB]">{v}</span>
          </div>
        ))}
      </div>
    </>
  );
}

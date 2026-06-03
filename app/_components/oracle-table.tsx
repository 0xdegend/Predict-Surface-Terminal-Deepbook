'use client';

/**
 * Active-oracle table — now a control surface, not just a readout. Clicking a
 * row selects that oracle on the 3-D surface (the marker jumps to its ATM node)
 * and loads it into the trade ticket, pre-filled at the at-the-money strike.
 * Rows with a live SVI snapshot are pickable; the rest render dimmed.
 */
import { useMemo } from 'react';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { useNow } from '@/lib/hooks/use-now';
import { useLiveOracleData } from '@/lib/hooks/use-live-oracle-data';
import { snapStrikeToTick } from '@/lib/keys';
import { toFloat } from '@/config/scale';
import { impliedVol, timeToExpiryYears } from '@/lib/svi/svi';
import { price, dateUTC, countdown, num, pct, shortId } from '@/lib/format';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

/** Markets inside this window are about to settle — minting may revert. */
const CLOSING_SOON_MS = 120_000;

export function OracleTable({
  oracles: initialOracles,
  inputs: initialInputs,
  serverNow,
}: {
  oracles: Oracle[];
  inputs: SmileInput[];
  serverNow: number;
}) {
  const selection = useSurfaceStore((s) => s.selection);
  const select = useSurfaceStore((s) => s.select);
  const now = useNow(serverNow);
  // Live set — picks up newly opened expiries and drops settled ones server-side
  // (the clock drops expired-but-unsettled below); no reload needed.
  const { oracles, inputs } = useLiveOracleData(initialOracles, initialInputs);

  const inputById = useMemo(() => {
    const m = new Map<string, SmileInput>();
    for (const i of inputs) m.set(i.oracle.oracle_id, i);
    return m;
  }, [inputs]);

  function pickOracle(input: SmileInput) {
    const { oracle, forward } = input;
    // At-the-money: snap the forward to the nearest tradeable grid strike.
    const strikeScaled = snapStrikeToTick(BigInt(Math.round(forward * 1e9)), oracle);
    select({
      oracleId: oracle.oracle_id,
      expiry: oracle.expiry,
      strikeScaled: strikeScaled.toString(),
      strike: toFloat(Number(strikeScaled)),
      isUp: true,
    });
    // Scroll the ticket into view on narrow layouts where it sits below.
    if (typeof document !== 'undefined') {
      document.getElementById('trade-ticket')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }

  // Once a market expires it's no longer tradeable — drop it from the picker so
  // the live list stays tight (any position you hold in it lives in Portfolio).
  // `now` ticks each second, so rows leave the table the moment they expire.
  const visible = oracles.filter((o) => o.expiry > now);
  const hiddenCount = oracles.length - visible.length;

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-wider text-[#8B9099]">
          Active oracles
        </h2>
        <span className="font-mono text-[10px] text-[#5A5F66]">
          {hiddenCount > 0 && <span className="mr-3">{hiddenCount} expired hidden</span>}
          click a row → loads the ticket
        </span>
      </div>

      {visible.length === 0 ? (
        <p className="mt-6 text-center text-[12px] text-[#5A5F66]">
          No active markets right now — waiting for the next expiry to open.
        </p>
      ) : (
      <div className="mt-3 overflow-x-auto">
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
          <thead>
            <tr className="text-left text-[10px] uppercase tracking-wider text-[#5A5F66]">
              <Th>Underlying</Th>
              <Th>Expiry (UTC)</Th>
              <Th>TTL</Th>
              <Th className="text-right">Forward</Th>
              <Th className="text-right">ATM IV</Th>
              <Th className="text-right">Min strike</Th>
              <Th className="text-right">Tick</Th>
              <Th>Oracle</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => {
              const input = inputById.get(o.oracle_id);
              const selected = selection?.oracleId === o.oracle_id;
              const closingSoon = o.expiry - now < CLOSING_SOON_MS;
              const pickable = !!input;
              const atmIv = input
                ? impliedVol(input.forward, input.forward, input.svi, Math.max(timeToExpiryYears(o.expiry, now), 0))
                : null;
              return (
                <tr
                  key={o.oracle_id}
                  onClick={pickable ? () => pickOracle(input!) : undefined}
                  tabIndex={pickable ? 0 : undefined}
                  onKeyDown={
                    pickable
                      ? (e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            pickOracle(input!);
                          }
                        }
                      : undefined
                  }
                  aria-selected={selected}
                  className={[
                    'border-t border-white/[0.05] transition-colors',
                    pickable
                      ? 'cursor-pointer hover:bg-white/[0.04] focus-visible:bg-white/[0.04] focus-visible:outline-none'
                      : 'opacity-40',
                    selected ? 'bg-up/[0.07]' : '',
                  ].join(' ')}
                >
                  <Td className="text-[#E6E8EB]">
                    <span className="inline-flex items-center gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${selected ? 'bg-up' : 'bg-transparent'}`}
                      />
                      {o.underlying_asset}
                    </span>
                  </Td>
                  <Td className="text-[#B4B8BE]">{dateUTC(o.expiry)}</Td>
                  <Td className={closingSoon ? 'text-down' : 'text-[#8B9099]'}>
                    {countdown(o.expiry, now)}
                  </Td>
                  <Td className="text-right text-[#B4B8BE]">
                    {input ? price(input.forward, 0) : '—'}
                  </Td>
                  <Td className="text-right text-[#B4B8BE]">{atmIv != null ? pct(atmIv, 1) : '—'}</Td>
                  <Td className="text-right text-[#8B9099]">{price(toFloat(o.min_strike), 0)}</Td>
                  <Td className="text-right text-[#8B9099]">{num(toFloat(o.tick_size), 2)}</Td>
                  <Td className="text-[#5A5F66]">{shortId(o.oracle_id)}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      )}
    </div>
  );
}

function Th({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <th className={`pb-2 pr-4 font-normal ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`py-1.5 pr-4 ${className}`}>{children}</td>;
}

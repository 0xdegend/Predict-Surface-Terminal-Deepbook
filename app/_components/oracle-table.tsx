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
        <h2 className="flex items-center gap-2">
          <span className="eyebrow">Active oracles</span>
          {visible.length > 0 && (
            <span className="rounded-full bg-[var(--bg-3)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-text-2">
              {visible.length}
            </span>
          )}
        </h2>
        <span className="font-mono text-[10px] text-text-3">
          {hiddenCount > 0 && <span className="mr-3">{hiddenCount} expired hidden</span>}
          click a row → loads the ticket
        </span>
      </div>

      {visible.length === 0 ? (
        <div className="card mt-3 flex flex-col items-center gap-1 px-4 py-10 text-center">
          <span className="text-[12px] text-text-2">No active markets right now</span>
          <span className="text-[11px] text-text-3">Waiting for the next expiry to open.</span>
        </div>
      ) : (
      // Self-contained scroll box: the header sticks to the TOP OF THIS BOX
      // (top-0), not the page. `overflow-auto` + a height cap makes this element
      // the sticky scroll container, so the header can never detach mid-table or
      // occlude a row the way a page-level `top-16` sticky did.
      <div className="scroll-quiet mt-3 max-h-[70vh] overflow-auto">
        <table className="w-full border-collapse font-mono text-[12px] tabular-nums">
          <thead>
            <tr className="sticky top-0 z-10 bg-bg-0 text-left text-[10px] uppercase tracking-wider text-text-3">
              <Th>Underlying</Th>
              <Th>Expiry (UTC)</Th>
              <Th>TTL</Th>
              <Th className="text-right">Forward</Th>
              <Th className="text-right">ATM IV</Th>
              <Th className="text-right">Min strike</Th>
              <Th className="text-right">Tick</Th>
              <Th className="text-right">Oracle</Th>
            </tr>
          </thead>
          <tbody>
            {visible.map((o) => {
              const input = inputById.get(o.oracle_id);
              const selected = selection?.oracleId === o.oracle_id;
              const msLeft = o.expiry - now;
              const closingSoon = msLeft < CLOSING_SOON_MS;
              const urgent = !closingSoon && msLeft < 15 * 60_000;
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
                    'group border-t border-line-soft transition-colors',
                    pickable
                      ? 'cursor-pointer hover:bg-white/[0.03] focus-visible:bg-white/[0.04] focus-visible:outline-none'
                      : 'opacity-40',
                    selected ? 'bg-[var(--accent-soft)]' : '',
                  ].join(' ')}
                >
                  <Td className="text-text-1">
                    <span className="relative inline-flex items-center gap-2.5 pl-2.5">
                      {/* selected accent rail */}
                      <span
                        className={`absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full transition-colors ${
                          selected ? 'bg-accent' : 'bg-transparent'
                        }`}
                      />
                      <span className="font-medium">{o.underlying_asset}</span>
                    </span>
                  </Td>
                  <Td className="text-text-2">{dateUTC(o.expiry)}</Td>
                  <Td>
                    {closingSoon ? (
                      <span className="rounded bg-[var(--down-soft)] px-1.5 py-0.5 text-down">
                        {countdown(o.expiry, now)}
                      </span>
                    ) : urgent ? (
                      <span className="rounded bg-[var(--warn-soft)] px-1.5 py-0.5 text-warn">
                        {countdown(o.expiry, now)}
                      </span>
                    ) : (
                      <span className="text-text-2">{countdown(o.expiry, now)}</span>
                    )}
                  </Td>
                  <Td className="text-right text-text-2">{input ? price(input.forward, 0) : '—'}</Td>
                  <Td className="text-right text-text-1">{atmIv != null ? pct(atmIv, 1) : '—'}</Td>
                  <Td className="text-right text-text-3">{price(toFloat(o.min_strike), 0)}</Td>
                  <Td className="text-right text-text-3">{num(toFloat(o.tick_size), 2)}</Td>
                  <Td className="text-right text-text-3 group-hover:text-text-2">
                    {shortId(o.oracle_id)}
                  </Td>
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
  return <th className={`px-3 pb-2.5 pt-1 font-normal ${className}`}>{children}</th>;
}

function Td({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-3 py-2.5 ${className}`}>{children}</td>;
}

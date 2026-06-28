'use client';

/**
 * V2OddsPanel — the rail's live odds table for the selected market (legacy
 * LiveSviPanel's role): fair UP/DN across the strike grid, highlighting the
 * strike the ticket currently has selected. Reads the shared store.
 */
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { upFair } from '@/lib/svi/svi';
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export function V2OddsPanel({ market, pricer }: { market: V2Market; pricer?: LivePricer }) {
  const strikeOffset = useV2TradeStore((s) => s.strikeOffset);
  if (!pricer) return null;

  const step = toFloat(market.admission_tick_size);
  const atm = toFloat(snapStrikeToAdmission(fromFloat(pricer.forward), BigInt(market.admission_tick_size)));
  const selected = atm + strikeOffset * step;
  const rows: number[] = [];
  for (let i = -4; i <= 4; i++) rows.push(atm + i * step);

  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium tracking-tight text-text-1">Market odds</h3>
        <span className="font-mono text-[11px] text-text-3">fair</span>
      </div>
      <table className="w-full text-right font-mono text-[12px] tabular-nums">
        <thead>
          <tr className="head-divider text-text-3 [&>th]:px-2 [&>th]:pb-1.5 [&>th]:font-normal">
            <th className="text-left">Strike</th>
            <th>Up</th>
            <th>Down</th>
          </tr>
        </thead>
        <tbody className="rows-divided">
          {rows.map((k) => {
            const up = upFair(k, pricer.forward, pricer.svi);
            const isSel = Math.abs(k - selected) < 1e-6;
            return (
              <tr key={k} className={`[&>td]:px-2 [&>td]:py-1.5 ${isSel ? 'bg-(--accent-soft)' : ''}`}>
                <td className="text-left text-text-2">${k.toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
                <td className="text-up">{(up * 100).toFixed(1)}%</td>
                <td className="text-down">{((1 - up) * 100).toFixed(1)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

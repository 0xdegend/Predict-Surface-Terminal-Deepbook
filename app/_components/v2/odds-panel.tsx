'use client';

/**
 * V2OddsPanel — the rail's live odds view for the selected market (legacy
 * LiveSviPanel's role). An interactive "chance BTC ends higher" curve: hover to
 * read the odds at any price, click/drag to set your strike (synced with the
 * ticket's payout slider). Replaces the old static fair-odds table.
 */
import { V2SmileChart } from './smile-chart';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

export function V2OddsPanel({ market, pricer }: { market: V2Market; pricer?: LivePricer }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between">
        <h3 className="text-[13px] font-medium tracking-tight text-text-1">Market odds</h3>
        <span className="font-mono text-[11px] text-text-3">fair</span>
      </div>
      {pricer ? (
        <V2SmileChart market={market} pricer={pricer} />
      ) : (
        <div className="card px-4 py-6 text-center text-[12px] text-text-3">Loading live odds…</div>
      )}
    </div>
  );
}

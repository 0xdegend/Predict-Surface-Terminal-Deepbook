'use client';

/**
 * V2PositionsPanel — the connected account's open positions with close/claim.
 *
 * Reads the owner-scoped indexer endpoint (empty on testnet today). Rows are read
 * defensively (shape unconfirmed — see V2Position); redeem wires to redeem_live
 * (still-trading market) or redeem_settled (settled). Once a real account holds
 * positions, confirm the field mapping here. Clean empty state until then.
 */
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useV2Positions } from '@/lib/hooks/use-v2-positions';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import { fromQuote } from '@/config/scale';
import type { V2Position } from '@/lib/api/v2/types';

export function V2PositionsPanel() {
  const acct = usePredictAccountV2();
  const { positions, isLoading } = useV2Positions(acct.owner);

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <h3 className="text-[14px] font-medium tracking-tight text-text-1">Open positions</h3>

      {!acct.owner ? (
        <p className="text-[12px] text-text-3">Connect your wallet to see your positions.</p>
      ) : isLoading ? (
        <p className="text-[12px] text-text-3">Loading positions…</p>
      ) : positions.length === 0 ? (
        <p className="text-[12px] leading-relaxed text-text-3">No open positions yet. Make a trade and it’ll show here.</p>
      ) : (
        <div className="rows-divided">
          {positions.map((p, i) => (
            <PositionRow key={positionKey(p, i)} p={p} acct={acct} />
          ))}
        </div>
      )}
      {acct.error && <p className="text-[11px] leading-relaxed text-down">{acct.error}</p>}
    </div>
  );
}

function PositionRow({ p, acct }: { p: V2Position; acct: ReturnType<typeof usePredictAccountV2> }) {
  const marketId = (p.expiry_market_id ?? p.market_id) as string | undefined;
  const orderId = p.order_id != null ? BigInt(p.order_id) : null;
  const qtyBase = BigInt(Math.round(Number(p.open_quantity ?? p.quantity ?? 0)));
  const dir = direction(p);
  const settled = isSettled(p);
  const markValue = p.mark_value != null ? fromQuote(p.mark_value) : null;
  const pnl = p.pnl != null ? fromQuote(p.pnl) : null;

  const canRedeem = !!marketId && orderId != null && qtyBase > 0n;
  async function redeem() {
    if (!canRedeem) return;
    const args = { marketId: marketId!, orderId: orderId!, closeQuantity: qtyBase };
    if (settled) await acct.redeemSettled(args);
    else await acct.redeemLive(args);
  }

  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2 text-[12px]">
          <span className={`font-medium ${dir === 'Up' ? 'text-up' : dir === 'Down' ? 'text-down' : 'text-text-1'}`}>{dir}</span>
          <span className="font-mono tabular-nums text-text-2">${fromQuote(qtyBase).toLocaleString(undefined, { maximumFractionDigits: 2 })} max</span>
          {settled && <span className="rounded-[3px] bg-white/5 px-1 py-0.5 text-[8px] uppercase tracking-wider text-text-3">settled</span>}
        </div>
        <div className="mt-0.5 font-mono text-[10px] text-text-3">
          {markValue != null && <span>value ${markValue.toFixed(2)}</span>}
          {pnl != null && <span className={`ml-2 ${pnl >= 0 ? 'text-up' : 'text-down'}`}>{pnl >= 0 ? '+' : ''}{pnl.toFixed(2)}</span>}
        </div>
      </div>
      <button
        onClick={redeem}
        disabled={!canRedeem || !!acct.busy}
        className="shrink-0 rounded-md bg-white/5 px-3 py-1.5 text-[12px] font-medium text-text-1 transition-colors hover:bg-white/8 disabled:opacity-50"
      >
        {acct.busy === 'redeem' ? '…' : settled ? 'Claim' : 'Close'}
      </button>
    </div>
  );
}

/* Defensive field reads (shape unconfirmed until populated). */
function direction(p: V2Position): 'Up' | 'Down' | 'Range' {
  const lo = p.lower_tick != null ? BigInt(p.lower_tick) : 0n;
  const hi = p.higher_tick != null ? BigInt(p.higher_tick) : 0n;
  if (hi === POS_INF_TICK) return 'Up';
  if (lo === 0n && hi !== 0n) return 'Down';
  return 'Range';
}
function isSettled(p: V2Position): boolean {
  return /settl|redeem|won|lost|expired/i.test(String(p.status ?? ''));
}
function positionKey(p: V2Position, i: number): string {
  return `${p.expiry_market_id ?? p.market_id ?? 'm'}-${p.order_id ?? i}`;
}

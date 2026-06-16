'use client';

/**
 * Range position card — a vertical-range bet (settles between two prices). The
 * compact sibling of PositionCard. Value/PnL are marked off the live range-fair
 * (or 1/0 once settled); the band is the hero. Redeem closes or claims it.
 */
import { useState } from 'react';
import { LuCalendarRange, LuCircleX, LuDownload, LuShare } from 'react-icons/lu';
import { fromQuote, toFloat } from '@/config/scale';
import { quote as fmtQuote, price, pct, signed, dateUTC, countdown } from '@/lib/format';
import { predictConfig } from '@/config/predict';
import { ShareCardModal } from './share-card-modal';
import type { ShareCardData } from './share-card-canvas';
import type { ValuedRangePosition } from '@/lib/hooks/use-range-positions';

export function RangePositionCard({
  position,
  now,
  onRedeem,
  busy,
}: {
  position: ValuedRangePosition;
  now: number;
  onRedeem: (p: ValuedRangePosition) => void;
  busy: boolean;
}) {
  const p = position;
  const [shareOpen, setShareOpen] = useState(false);
  const lower = toFloat(p.lowerStrike);
  const higher = toFloat(p.higherStrike);
  const contracts = fromQuote(p.openQty);
  const cost = fromQuote(p.openCostBasis);
  const value = fromQuote(p.currentValue);
  const pnl = fromQuote(p.unrealizedPnl);
  const pnlPct = p.openCostBasis > 0 ? p.unrealizedPnl / p.openCostBasis : 0;
  const expired = p.expiry - now <= 0;
  const decided = p.settled || expired;
  const won = p.fairUp >= 0.5;
  // Decided OUT of the band → the bet paid nothing, so there's no payout to
  // "redeem". Don't show an inviting green Redeem; offer a muted "Clear" that
  // just removes the now-worthless position from the manager (redeems 0).
  // Keys off `decided` (settled OR expired) + `won` — same signal as the OUT
  // badge above — because `p.settled` only flips once a redeem record exists,
  // which a never-redeemed loser never has.
  const worthless = decided && !won;
  const positive = pnl >= 0;
  const sym = predictConfig.quote.symbol;
  const asset = p.underlying || 'BTC';

  const shareData: ShareCardData = {
    underlying: asset,
    up: true, // unused when `band` is present
    strike: 0,
    expiry: p.expiry,
    result: decided ? (won ? 'won' : 'lost') : 'live',
    decided,
    pnl,
    pnlPct,
    cost,
    contracts,
    entryPrice: p.avgEntryPrice / 1e9, // per-unit ask in [0,1]
    markPrice: p.fairUp,
    spark: [],
    band: { lower, higher },
  };

  return (
    <div className="glass-card up interactive relative overflow-hidden font-mono text-[12px] tabular-nums">
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5"
        style={{
          background: `linear-gradient(90deg, transparent, ${decided ? (won ? 'var(--up)' : 'var(--down)') : 'var(--up)'}, transparent)`,
          opacity: decided ? 0.7 : 0.3,
        }}
      />
      <div className="flex flex-col gap-3 p-3.5 sm:p-4">
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className="h-1.5 w-1.5 rounded-full bg-up" />
            <span className="eyebrow">{asset} Range</span>
          </span>
          <div className="flex items-center gap-2.5">
            {decided ? (
              <span
                className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                  won ? 'bg-(--accent-soft) text-up' : 'bg-(--down-soft) text-down'
                }`}
              >
                {won ? 'In band' : 'Out'}
              </span>
            ) : (
              <span className="text-[11px] tabular-nums text-text-2">{countdown(p.expiry, now)} left</span>
            )}
            <button
              onClick={() => setShareOpen(true)}
              aria-label="Share position as image"
              className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2"
            >
              <LuShare size={13} />
            </button>
          </div>
        </div>

        {/* The band — hero */}
        <div className="glass-inset flex items-center justify-between gap-3 p-4">
          <div className="flex items-center gap-3">
            <span className="dir-orb up scale-90" aria-hidden>
              <LuCalendarRange size={18} />
            </span>
            <div className="flex flex-col gap-1">
              <h3 className="text-[15px] leading-none text-text-1">
                {price(lower)} <span className="text-text-3">—</span> {price(higher)}
              </h3>
              <p className="font-sans text-[11px] text-text-2">
                {asset} settles in this band · {dateUTC(p.expiry, false)}
              </p>
            </div>
          </div>
          <div className="flex flex-col items-end gap-1">
            <span className="eyebrow">{decided ? 'Realized' : 'Unrealized'} PnL</span>
            <span className={`flex items-baseline gap-1.5 ${positive ? 'text-up' : 'text-down'}`}>
              <span className="text-[24px] leading-none tracking-tight">{signed(pnl)}</span>
              <span className="text-[11px] text-text-3">{sym}</span>
            </span>
            <span className={`text-[12px] ${positive ? 'text-up' : 'text-down'}`}>
              {signed(pnlPct * 100, 1)}%
            </span>
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 gap-x-6 gap-y-3 px-1 @lg:grid-cols-4">
          <Mini label="Size" value={`${fmtQuote(contracts)}`} sub="contracts" />
          <Mini label="Cost" value={fmtQuote(cost)} sub={sym} />
          <Mini label={decided ? 'Settled' : 'Chance in band'} value={pct(p.fairUp, 1)} sub="" />
          <Mini label={decided ? (won ? 'Payout' : 'Final') : 'Value'} value={fmtQuote(value)} sub={sym} />
        </div>

        {/* Action */}
        <div className="flex items-center justify-between gap-3 px-1">
          <p className="font-sans text-[10px] leading-snug text-text-3">
            {worthless
              ? `Settled out of the band — this bet paid nothing.`
              : `Pays 1.00 ${sym} per contract if ${asset} settles in the band.`}
          </p>
          <button
            onClick={() => onRedeem(p)}
            disabled={busy}
            title={worthless ? 'Remove this settled position — it paid nothing' : undefined}
            className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest transition-all disabled:opacity-50 ${
              worthless
                ? 'border-line text-text-3 hover:border-line-strong hover:bg-white/[0.04] hover:text-text-2'
                : decided
                  ? 'border-up/50 bg-up/10 text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/20'
                  : 'border-down/45 text-down hover:border-down/70 hover:bg-down/10'
            }`}
          >
            {worthless ? 'Clear' : decided ? 'Redeem range' : 'Close range'}
            {worthless ? <LuCircleX size={14} /> : decided ? <LuDownload size={14} /> : <LuCircleX size={14} />}
          </button>
        </div>
      </div>

      <ShareCardModal open={shareOpen} onClose={() => setShareOpen(false)} data={shareData} />
    </div>
  );
}

function Mini({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="eyebrow">{label}</span>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[15px] leading-none tracking-tight text-text-1">{value}</span>
        {sub && <span className="text-[9px] uppercase tracking-widest text-text-3">{sub}</span>}
      </span>
    </div>
  );
}

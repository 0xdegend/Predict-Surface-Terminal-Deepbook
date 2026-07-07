'use client';

/**
 * V2SmileChart — the interactive "chance BTC ends higher" curve for the selected
 * market (legacy SmileStrip's role, rebuilt on the v2 store + admission grid).
 *
 * Hover anywhere to read the fair UP/DOWN odds at that price. Click or drag to
 * set your strike — it maps the pointed price onto the admission grid and writes
 * `strikeOffset`, staying in sync with the ticket's payout slider (both read/
 * write the same store). A crosshair marks the current strike; the dashed level
 * line shows the picked side's chance. Butterfly violations (odds ticking back
 * up as price rises — a free-money gap) are flagged; on live data they're rare.
 *
 * Pure viz math from lib/svi (mirrors the on-chain pricing); it never quotes a
 * trade price — the ticket + on-chain guards own that.
 */
import { useRef, useState } from 'react';
import { upFair } from '@/lib/svi/svi';
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { price, pct } from '@/lib/format';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { InfoTip } from '@/app/_components/ui/info-tip';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const W = 320;
const H = 120;
const PAD = { l: 8, r: 8, t: 10, b: 16 };

// Sampling window (fraction of forward) and resolution. Cropped to the readable
// odds band below; the tails carry no decision and squash the live S-curve.
const SPAN = 0.12;
const SAMPLES = 121;
const PMIN = 0.02;
const PMAX = 0.98;

export function V2SmileChart({ market, pricer }: { market: V2Market; pricer: LivePricer }) {
  const strikeOffset = useV2TradeStore((s) => s.strikeOffset);
  const isUp = useV2TradeStore((s) => s.isUp);
  const setStrikeOffset = useV2TradeStore((s) => s.setStrikeOffset);

  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  const dragging = useRef(false);

  const { forward, svi } = pricer;
  const step = toFloat(market.admission_tick_size) || 1;
  const atm = toFloat(snapStrikeToAdmission(fromFloat(forward), BigInt(market.admission_tick_size)));
  const selStrike = atm + strikeOffset * step;

  // Sample the UP curve linearly in price across a generous window.
  const all: { strike: number; up: number }[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const strike = forward * (1 - SPAN) + ((forward * 2 * SPAN) * i) / (SAMPLES - 1);
    all.push({ strike, up: upFair(strike, forward, svi) });
  }

  // Butterfly / no-arb check over the full curve: UP must be monotone
  // non-increasing in strike. A tick back up = an internally inconsistent price.
  let hasButterfly = false;
  const butterflies: { strike: number; up: number }[] = [];
  for (let i = 1; i < all.length; i++) {
    if (all[i].up > all[i - 1].up + 1e-4) {
      hasButterfly = true;
      butterflies.push(all[i]);
    }
  }

  // Crop to the readable probability band (~2%–98%). up descends with strike.
  let lo = all.findIndex((p) => p.up <= PMAX);
  if (lo < 0) lo = 0;
  let hi = all.length - 1;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].up >= PMIN) {
      hi = i;
      break;
    }
  }
  lo = Math.max(0, lo - 1);
  hi = Math.min(all.length - 1, hi + 1);
  const pts = all.slice(lo, hi + 1);
  if (pts.length < 2) return null;

  const xMin = pts[0].strike;
  const xMax = pts[pts.length - 1].strike;
  const xSpan = xMax - xMin || 1;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const sx = (strike: number) => PAD.l + ((strike - xMin) / xSpan) * plotW;
  const cx = (strike: number) => sx(Math.max(xMin, Math.min(xMax, strike)));
  const sy = (up: number) => PAD.t + (1 - up) * plotH;

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.strike).toFixed(1)},${sy(p.up).toFixed(1)}`).join(' ');
  const fwdX = cx(forward);
  const atmUp = upFair(atm, forward, svi);

  const selUp = upFair(selStrike, forward, svi);
  const selChance = isUp ? selUp : 1 - selUp;

  const hUp = hoverPrice != null ? upFair(hoverPrice, forward, svi) : null;

  function priceAt(e: React.PointerEvent<SVGSVGElement>): number {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const t = (vx - PAD.l) / plotW;
    return xMin + Math.max(0, Math.min(1, t)) * xSpan;
  }

  function setStrikeAt(p: number) {
    setStrikeOffset(Math.round((p - atm) / step));
  }

  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = priceAt(e);
    setHoverPrice(p);
    setStrikeAt(p);
  }
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = priceAt(e);
    setHoverPrice(p);
    if (dragging.current) setStrikeAt(p);
  }
  function onUp(e: React.PointerEvent<SVGSVGElement>) {
    dragging.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-text-3">
          Chance BTC ends higher
          <InfoTip label="chance of ending higher">
            For each price level, the market&apos;s fair odds that BTC finishes above it by expiry. The
            odds drop as the price gets higher, and sit near 50% around today&apos;s price.
          </InfoTip>
        </span>
        {hasButterfly ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-down">
            Prices look off ⚠
            <InfoTip label="prices look off">
              The odds should drop smoothly as the price rises. Here they tick back up somewhere, which
              doesn&apos;t add up (a free-money gap). On live data this almost never happens.
            </InfoTip>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-up">
            Prices look healthy ✓
            <InfoTip label="prices look healthy">
              The odds drop smoothly as the price rises — everything lines up, with no free-money gaps
              in the pricing.
            </InfoTip>
          </span>
        )}
      </div>

      <div className="relative">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          className="card block cursor-crosshair touch-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => setHoverPrice(null)}
        >
          {/* 0 / 50 / 100% gridlines + labels */}
          {[0, 0.5, 1].map((p) => (
            <g key={p}>
              <line
                x1={PAD.l}
                y1={sy(p)}
                x2={W - PAD.r}
                y2={sy(p)}
                stroke="rgba(255,255,255,0.05)"
                strokeDasharray={p === 0.5 ? '2 3' : undefined}
              />
              <text x={PAD.l + 1} y={sy(p) - 2} fill="var(--text-3)" fontSize={8} fontFamily="monospace">
                {Math.round(p * 100)}%
              </text>
            </g>
          ))}

          {/* forward marker */}
          <line x1={fwdX} y1={PAD.t} x2={fwdX} y2={H - PAD.b} stroke="rgba(255,255,255,0.12)" />

          {/* selected strike crosshair */}
          <line
            x1={cx(selStrike)}
            y1={PAD.t}
            x2={cx(selStrike)}
            y2={H - PAD.b}
            stroke="var(--accent)"
            strokeWidth={1}
            opacity={0.45}
          />

          <path d={path} fill="none" stroke="var(--up)" strokeWidth={1.5} />
          {butterflies.map((p) => (
            <circle key={p.strike} cx={sx(p.strike)} cy={sy(p.up)} r={2.5} fill="var(--down)" />
          ))}

          {/* picked side's chance — a level on the 0–100% axis */}
          <line
            x1={PAD.l}
            y1={sy(selChance)}
            x2={W - PAD.r}
            y2={sy(selChance)}
            stroke="var(--accent)"
            strokeWidth={1}
            strokeDasharray="4 3"
            opacity={0.85}
          />
          <text x={W - PAD.r - 1} y={sy(selChance) - 3} fill="var(--accent)" fontSize={9} fontFamily="monospace" textAnchor="end">
            {pct(selChance, 0)} chance
          </text>

          {/* hover guide + dot */}
          {hoverPrice != null && hUp != null && (
            <>
              <line x1={cx(hoverPrice)} y1={PAD.t} x2={cx(hoverPrice)} y2={H - PAD.b} stroke="var(--up)" strokeWidth={0.75} opacity={0.5} />
              <circle cx={cx(hoverPrice)} cy={sy(hUp)} r={3.5} fill="var(--up)" opacity={0.2} />
              <circle cx={cx(hoverPrice)} cy={sy(hUp)} r={2} fill="var(--up)" />
            </>
          )}

          {/* price axis labels */}
          <text x={PAD.l} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
            {price(xMin, 0)}
          </text>
          <text x={W - PAD.r} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace" textAnchor="end">
            {price(xMax, 0)}
          </text>
        </svg>

        {/* hover readout — odds at the exact pointed price */}
        {hoverPrice != null && hUp != null && (
          <div className="glass pointer-events-none absolute right-1.5 top-1.5 z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-right">
            <div className="font-mono text-[11px] leading-none tabular-nums text-text-2">above {price(hoverPrice, 0)}</div>
            <div className="mt-1 flex items-center justify-end gap-1.5 font-mono text-[11px] leading-none tabular-nums">
              <span className="text-up">{pct(hUp, 0)} UP</span>
              <span className="text-text-3">·</span>
              <span className="text-down">{pct(1 - hUp, 0)} DOWN</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between font-mono text-[10px] tabular-nums text-text-3">
        <span className="inline-flex items-center gap-1">
          expected {price(forward)}
          <InfoTip label="expected price">
            Where the market expects BTC to be at expiry (today&apos;s price carried forward). Right here,
            ending higher or lower is close to a coin flip.
          </InfoTip>
        </span>
        <span className="inline-flex items-center gap-1">
          ≈ 50/50 at {pct(atmUp, 1)} up
          <InfoTip label="the 50/50 point">
            Around the expected price, ending higher or lower is roughly even — about as close to a coin
            flip as this market gets.
          </InfoTip>
        </span>
      </div>
    </div>
  );
}

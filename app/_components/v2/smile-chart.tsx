'use client';

/**
 * V2SmileChart — the interactive "chance BTC ends higher" curve for the selected
 * market (legacy SmileStrip's role, rebuilt on the v2 store + admission grid).
 *
 * Hover anywhere to read the fair UP/DOWN odds at that price.
 *  - Binary mode: click or drag to set your strike — maps the pointed price onto
 *    the admission grid and writes the absolute `strikePrice`, synced with the
 *    ticket's payout slider (both read/write the same store). A crosshair marks
 *    the strike; the dashed level line shows the picked side's chance.
 *  - Range mode (legacy SmileStrip parity): tap two price levels to set the band
 *    — the first tap anchors, a live preview shades to the pointer, the second
 *    tap closes it. Then drag either edge handle to resize, tap elsewhere to
 *    re-pick, or Reset. The dashed level shows the band's fair chance of landing
 *    inside.
 *
 * Butterfly violations (odds ticking back up as price rises — a free-money gap)
 * are flagged; on live data they're rare. Pure viz math from lib/svi (mirrors
 * the on-chain pricing); it never quotes a trade price.
 */
import { useRef, useState } from 'react';
import { upFair, rangeFair } from '@/lib/svi/svi';
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
const SPAN = 0.12;
const SAMPLES = 121;
const PMIN = 0.02;
const PMAX = 0.98;
const GRAB_PX = 16; // how near (viewBox x) the pointer must be to grab a band edge

export function V2SmileChart({ market, pricer }: { market: V2Market; pricer: LivePricer }) {
  const mode = useV2TradeStore((s) => s.mode);
  const strikePrice = useV2TradeStore((s) => s.strikePrice);
  const isUp = useV2TradeStore((s) => s.isUp);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const rangeLowerPrice = useV2TradeStore((s) => s.rangeLowerPrice);
  const rangeHigherPrice = useV2TradeStore((s) => s.rangeHigherPrice);
  const rangeAnchorPrice = useV2TradeStore((s) => s.rangeAnchorPrice);
  const setRangeBand = useV2TradeStore((s) => s.setRangeBand);
  const pickRangeLevel = useV2TradeStore((s) => s.pickRangeLevel);
  const clearRange = useV2TradeStore((s) => s.clearRange);

  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  // Which handle is being dragged (state, not a ref, so the active edge's
  // highlight can render). null = not dragging.
  const [drag, setDrag] = useState<'strike' | 'lower' | 'higher' | null>(null);
  // True from the moment an edge drag started until the next pick — swallows the
  // synthetic click that follows pointerup so a drag never re-anchors the band.
  const draggedRef = useRef(false);
  // The x-window frozen at the start of an edge drag. The window normally reframes
  // to fit the band, but doing that live mid-drag would rescale the x-axis every
  // frame and make the dragged handle drift off the cursor — so we pin it during
  // the gesture and let it reframe on release.
  const dragWinRef = useRef<{ min: number; max: number } | null>(null);

  const { forward, svi } = pricer;
  const step = toFloat(market.admission_tick_size) || 1;
  const atm = toFloat(snapStrikeToAdmission(fromFloat(forward), BigInt(market.admission_tick_size)));
  const rangeMode = mode === 'range';
  const bandSet = rangeLowerPrice != null && rangeHigherPrice != null;

  // Absolute strikes (pinned), defaulting to ATM until picked.
  const selStrike = strikePrice ?? atm;
  const lowerStrike = bandSet ? rangeLowerPrice : null;
  const higherStrike = bandSet ? rangeHigherPrice : null;
  const anchorStrike = rangeAnchorPrice;

  // Sample the UP curve linearly in price across a generous window.
  const all: { strike: number; up: number }[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const strike = forward * (1 - SPAN) + ((forward * 2 * SPAN) * i) / (SAMPLES - 1);
    all.push({ strike, up: upFair(strike, forward, svi) });
  }

  // Butterfly / no-arb check: UP must be monotone non-increasing in strike.
  let hasButterfly = false;
  const butterflies: { strike: number; up: number }[] = [];
  for (let i = 1; i < all.length; i++) {
    if (all[i].up > all[i - 1].up + 1e-4) {
      hasButterfly = true;
      butterflies.push(all[i]);
    }
  }

  // Readable crop (~2%–98%) — the default framing when no band is picked. up
  // descends with strike.
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
  const readMin = all[lo].strike;
  const readMax = all[hi].strike;
  const sampleMin = all[0].strike;
  const sampleMax = all[all.length - 1].strike;

  // The x-window. A picked band gets framed around itself with padding, so it
  // always reads as a comfortable shaded region — never a hairline sliver, never
  // clamped flat against an edge, regardless of how wide the readable crop is.
  // Otherwise we use the readable crop. Either way a MINIMUM span keeps the curve
  // from collapsing into a near-vertical line as expiry approaches (tiny
  // time-to-expiry ⇒ a near-step probability curve, which is what made the chart
  // look "thin"/degenerate on the 1-minute markets).
  let winMin: number;
  let winMax: number;
  if ((drag === 'lower' || drag === 'higher') && dragWinRef.current) {
    // Mid edge-drag: keep the framing pinned so the handle tracks the cursor 1:1.
    winMin = dragWinRef.current.min;
    winMax = dragWinRef.current.max;
  } else if (rangeMode && lowerStrike != null && higherStrike != null) {
    const bandSpan = higherStrike - lowerStrike;
    const pad = Math.max(bandSpan * 0.6, forward * 0.0015, step * 3);
    winMin = lowerStrike - pad;
    winMax = higherStrike + pad;
  } else {
    winMin = readMin;
    winMax = readMax;
  }
  const MIN_WIN = Math.max(forward * 0.004, step * 12);
  if (winMax - winMin < MIN_WIN) {
    const mid = (winMin + winMax) / 2;
    winMin = mid - MIN_WIN / 2;
    winMax = mid + MIN_WIN / 2;
  }
  // Keep the window within the sampled range.
  winMin = Math.max(winMin, sampleMin);
  winMax = Math.min(winMax, sampleMax);
  const xSpan = winMax - winMin;
  if (!(xSpan > 0)) return null;

  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const sx = (strike: number) => PAD.l + ((strike - winMin) / xSpan) * plotW;
  const cx = (strike: number) => sx(Math.max(winMin, Math.min(winMax, strike)));
  const sy = (up: number) => PAD.t + (1 - up) * plotH;

  // Draw the curve at a fixed resolution across the window (not off the coarse
  // sample grid), so even a narrow near-expiry window renders a smooth line.
  const DISP = 96;
  const path = Array.from({ length: DISP }, (_, i) => {
    const strike = winMin + (xSpan * i) / (DISP - 1);
    return `${i === 0 ? 'M' : 'L'}${sx(strike).toFixed(1)},${sy(upFair(strike, forward, svi)).toFixed(1)}`;
  }).join(' ');
  const fwdX = cx(forward);
  const atmUp = upFair(atm, forward, svi);

  // The level shown on the 0–100% axis: binary = picked side's chance; range =
  // the band's chance of landing inside (lower, higher].
  const selUp = upFair(selStrike, forward, svi);
  const bandChance = lowerStrike != null && higherStrike != null ? rangeFair(lowerStrike, higherStrike, forward, svi) : null;
  const levelChance = rangeMode ? bandChance : isUp ? selUp : 1 - selUp;

  const hUp = hoverPrice != null ? upFair(hoverPrice, forward, svi) : null;

  function priceAt(e: React.PointerEvent<SVGSVGElement>): number {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const t = (vx - PAD.l) / plotW;
    return winMin + Math.max(0, Math.min(1, t)) * xSpan;
  }
  function vxOf(e: React.PointerEvent<SVGSVGElement>): number {
    const rect = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * W;
  }
  /** Snap a pointed price onto the admission grid (absolute price). */
  function snapPrice(p: number) {
    return atm + Math.round((p - atm) / step) * step;
  }
  /** The band edge nearest the pointer, if within GRAB_PX — else null. */
  function edgeNear(vx: number): 'lower' | 'higher' | null {
    if (lowerStrike == null || higherStrike == null) return null;
    const dLo = Math.abs(vx - cx(lowerStrike));
    const dHi = Math.abs(vx - cx(higherStrike));
    if (Math.min(dLo, dHi) > GRAB_PX) return null;
    return dLo <= dHi ? 'lower' : 'higher';
  }
  function applyEdge(edge: 'lower' | 'higher', p: number) {
    if (rangeLowerPrice == null || rangeHigherPrice == null) return;
    const sp = snapPrice(p);
    // Keep the edges at least one grid step apart.
    if (edge === 'lower') setRangeBand(Math.min(sp, rangeHigherPrice - step), rangeHigherPrice);
    else setRangeBand(rangeLowerPrice, Math.max(sp, rangeLowerPrice + step));
  }

  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const p = priceAt(e);
    setHoverPrice(p);
    if (rangeMode) {
      const edge = edgeNear(vxOf(e));
      if (edge) {
        draggedRef.current = true;
        dragWinRef.current = { min: winMin, max: winMax };
        setDrag(edge);
        applyEdge(edge, p);
      }
    } else {
      setDrag('strike');
      setStrikePrice(snapPrice(p));
    }
  }
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const p = priceAt(e);
    setHoverPrice(p);
    if (drag === 'strike') setStrikePrice(snapPrice(p));
    else if (drag === 'lower' || drag === 'higher') applyEdge(drag, p);
  }
  function onUp(e: React.PointerEvent<SVGSVGElement>) {
    setDrag(null);
    dragWinRef.current = null;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
  }

  /** In range mode, a tap sets a band bound at the pointed price (snapped to the
   *  admission grid): first tap anchors, second closes the band (legacy parity). */
  function onPick(e: React.PointerEvent<SVGSVGElement>) {
    if (!rangeMode) return;
    // Swallow the click that trails a band-edge drag so it doesn't re-anchor.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    pickRangeLevel(snapPrice(priceAt(e)));
  }

  const overEdge = rangeMode && hoverPrice != null && edgeNear(cx(hoverPrice)) != null;
  // While placing the second bound, the live chance of the band so far — drag
  // until it reads the odds you want (legacy parity).
  const liveRangeChance =
    rangeMode && anchorStrike != null && !bandSet && hoverPrice != null
      ? rangeFair(Math.min(anchorStrike, hoverPrice), Math.max(anchorStrike, hoverPrice), forward, svi)
      : null;

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
          className={`card block touch-none ${overEdge ? 'cursor-ew-resize' : 'cursor-crosshair'}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => setHoverPrice(null)}
          onClick={onPick}
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

          {/* range band — shaded region + draggable edges */}
          {rangeMode && lowerStrike != null && higherStrike != null && (
            <>
              <rect
                x={cx(lowerStrike)}
                y={PAD.t}
                width={Math.max(0, cx(higherStrike) - cx(lowerStrike))}
                height={plotH}
                fill="var(--up)"
                opacity={0.14}
              />
              {(['lower', 'higher'] as const).map((edge) => {
                const x = cx(edge === 'lower' ? lowerStrike : higherStrike);
                const active = drag === edge;
                const pillH = 22;
                const pillY = PAD.t + plotH / 2 - pillH / 2;
                return (
                  <g key={edge}>
                    <line x1={x} y1={PAD.t} x2={x} y2={H - PAD.b} stroke="var(--up)" strokeWidth={active ? 1.75 : 1} opacity={active ? 1 : 0.75} />
                    <rect x={x - 4} y={pillY} width={8} height={pillH} rx={4} fill="var(--up)" stroke="rgba(0,0,0,0.5)" strokeWidth={0.75} opacity={active ? 1 : 0.95} />
                    <line x1={x - 1.5} y1={pillY + 6} x2={x - 1.5} y2={pillY + pillH - 6} stroke="rgba(0,0,0,0.45)" strokeWidth={0.75} />
                    <line x1={x + 1.5} y1={pillY + 6} x2={x + 1.5} y2={pillY + pillH - 6} stroke="rgba(0,0,0,0.45)" strokeWidth={0.75} />
                  </g>
                );
              })}
            </>
          )}

          {/* range anchor — first bound set, preview to the pointed price */}
          {rangeMode && !bandSet && anchorStrike != null && (
            <>
              {hoverPrice != null && (
                <rect
                  x={Math.min(cx(anchorStrike), cx(hoverPrice))}
                  y={PAD.t}
                  width={Math.abs(cx(hoverPrice) - cx(anchorStrike))}
                  height={plotH}
                  fill="var(--up)"
                  opacity={0.08}
                />
              )}
              <line x1={cx(anchorStrike)} y1={PAD.t} x2={cx(anchorStrike)} y2={H - PAD.b} stroke="var(--up)" strokeWidth={1} opacity={0.7} strokeDasharray="3 2" />
            </>
          )}

          {/* binary selection crosshair */}
          {!rangeMode && (
            <line x1={cx(selStrike)} y1={PAD.t} x2={cx(selStrike)} y2={H - PAD.b} stroke="var(--accent)" strokeWidth={1} opacity={0.45} />
          )}

          <path d={path} fill="none" stroke="var(--up)" strokeWidth={1.5} />
          {butterflies
            .filter((p) => p.strike >= winMin && p.strike <= winMax)
            .map((p) => (
              <circle key={p.strike} cx={sx(p.strike)} cy={sy(p.up)} r={2.5} fill="var(--down)" />
            ))}

          {/* chance level line (binary side chance / range band chance) */}
          {levelChance != null && (
            <>
              <line x1={PAD.l} y1={sy(levelChance)} x2={W - PAD.r} y2={sy(levelChance)} stroke="var(--accent)" strokeWidth={1} strokeDasharray="4 3" opacity={0.85} />
              <text x={W - PAD.r - 1} y={sy(levelChance) - 3} fill="var(--accent)" fontSize={9} fontFamily="monospace" textAnchor="end">
                {pct(levelChance, 0)} chance
              </text>
            </>
          )}

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
            {price(winMin, 0)}
          </text>
          <text x={W - PAD.r} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace" textAnchor="end">
            {price(winMax, 0)}
          </text>
        </svg>

        {/* range mode — band summary / pick instruction + reset (legacy parity) */}
        {rangeMode && (
          <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1.5">
            <div className="glass pointer-events-none whitespace-nowrap rounded-md px-2 py-1 font-mono text-[10px] leading-none tabular-nums">
              {lowerStrike != null && higherStrike != null ? (
                <span className="text-up">
                  {price(lowerStrike, 0)}–{price(higherStrike, 0)}
                  {bandChance != null && <span className="text-text-3"> · {pct(bandChance, 0)} chance</span>}
                  <span className="text-text-3"> · drag edges</span>
                </span>
              ) : anchorStrike != null ? (
                <span className="text-text-2">
                  tap upper price
                  {liveRangeChance != null && (
                    <span className="text-up"> · {pct(liveRangeChance, 0)} chance</span>
                  )}
                </span>
              ) : (
                <span className="text-text-2">tap two prices to set a range</span>
              )}
            </div>
            {(bandSet || anchorStrike != null) && (
              <button
                type="button"
                onClick={clearRange}
                className="glass pointer-events-auto rounded-md px-2 py-1 font-mono text-[10px] leading-none text-text-3 transition-colors hover:text-text-1"
              >
                Reset
              </button>
            )}
          </div>
        )}

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

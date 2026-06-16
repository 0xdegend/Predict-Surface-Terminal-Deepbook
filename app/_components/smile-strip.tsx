'use client';

/**
 * Smile strip — a compact, INTERACTIVE chart of the market's fair odds of
 * settling UP across the price grid for one expiry. Hover (or drag on touch) to
 * read the odds at any price level. The curve falls as the price level rises
 * (harder to finish above a higher price); it crosses ~50% at the forward. Any
 * butterfly violation (odds rising with price — internally inconsistent) is
 * flagged. The 3-D surface shows the whole thing; this is the readable slice.
 */
import { useMemo, useRef, useState } from 'react';
import { buildSmile, type SmileInput } from '@/lib/svi/surface';
import { rangeFair, upFair } from '@/lib/svi/svi';
import { gridBounds, snapStrikeToTick } from '@/lib/keys';
import { toFloat } from '@/config/scale';
import { price, pct } from '@/lib/format';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { InfoTip } from './ui/info-tip';

const W = 320;
const H = 120;
const PAD = { l: 8, r: 8, t: 10, b: 16 };

export function SmileStrip({ input }: { input: SmileInput }) {
  // Exact price under the pointer (continuous), not a sampled vertex index — so a
  // trader can dial any chance, snapping to the $1 grid only at pick time.
  const [hoverPrice, setHoverPrice] = useState<number | null>(null);
  // Which finalized band edge is being dragged (null = not dragging). The svg ref
  // lets a drag map clientX → price even when the pointer leaves the handle.
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragEdge, setDragEdge] = useState<'lower' | 'higher' | null>(null);
  // True from the moment a handle drag started until the next pick — swallows the
  // synthetic click that follows pointerup so a drag never re-anchors the band.
  const draggedRef = useRef(false);
  const ticketMode = useSurfaceStore((s) => s.ticketMode);
  const pickRangeStrike = useSurfaceStore((s) => s.pickRangeStrike);
  const setRangeBand = useSurfaceStore((s) => s.setRangeBand);
  const clearRange = useSurfaceStore((s) => s.clearRange);
  const selection = useSurfaceStore((s) => s.selection);
  const anchor = useSurfaceStore((s) => s.rangeAnchor);
  const band = useSurfaceStore((s) => s.rangeSelection);
  // Generate a generous window, then crop to the readable odds band below.
  // Memoized so hover (local state) never recomputes the SVI samples per move.
  const smile = useMemo(() => buildSmile(input, { half: 80, spanK: 0.2 }), [input]);
  const allPts = smile.points;
  if (allPts.length < 2) return null;

  const oracle = input.oracle;
  const fwd = smile.forward;
  const rangeMode = ticketMode === 'range';
  const bandForThis = band && band.oracleId === oracle.oracle_id ? band : null;
  const anchorForThis = anchor && anchor.oracleId === oracle.oracle_id ? anchor : null;
  const selForThis =
    !rangeMode && selection && selection.oracleId === oracle.oracle_id ? selection : null;
  const bandFair = bandForThis
    ? rangeFair(bandForThis.lower, bandForThis.higher, input.forward, input.svi, input.settlement ?? null)
    : null;

  // The chance of the *picked* market, plotted on the 0–100% axis: a range pays
  // if settlement lands in the band; a binary pays per its UP/DOWN side.
  const selChance = bandForThis
    ? bandFair
    : selForThis
      ? (() => {
          const up = upFair(selForThis.strike, input.forward, input.svi, input.settlement ?? null);
          return selForThis.isUp ? up : 1 - up;
        })()
      : null;

  // Crop to the readable probability band (~2%–98% chance). The flat 0%/100%
  // tails carry no decision and squash the live S-curve into an unpickable cliff.
  // Cheaper far-OTM strikes stay reachable via the ticket's strike stepper.
  const PMIN = 0.02;
  const PMAX = 0.98;
  let lo = allPts.findIndex((p) => p.up <= PMAX); // up descends with strike
  if (lo < 0) lo = 0;
  let hi = allPts.length - 1;
  for (let i = allPts.length - 1; i >= 0; i--) {
    if (allPts[i].up >= PMIN) {
      hi = i;
      break;
    }
  }
  // One point of margin each side for a thin tail of context.
  lo = Math.max(0, lo - 1);
  hi = Math.min(allPts.length - 1, hi + 1);
  const pts = allPts.slice(lo, hi + 1);

  // Linear price x-axis across the cropped window — labels read as real prices.
  const xMin = pts[0].strike;
  const xMax = pts[pts.length - 1].strike;
  const xSpan = xMax - xMin || 1;
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const sx = (strike: number) => PAD.l + ((strike - xMin) / xSpan) * plotW;
  const cx = (strike: number) => sx(Math.max(xMin, Math.min(xMax, strike))); // clamped to plot
  const sy = (up: number) => PAD.t + (1 - up) * plotH; // 0 → bottom, 1 → top

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.strike).toFixed(1)},${sy(p.up).toFixed(1)}`).join(' ');
  const fwdX = cx(fwd);
  const butterflies = pts.filter((p) => p.butterfly);
  const atm = smile.points[Math.floor(smile.points.length / 2)]?.up ?? 0;
  const asset = input.oracle.underlying_asset;

  // Map the pointer's x straight to a price (interpolated across the plot) so
  // picking isn't quantized to the few plotted vertices.
  function priceAt(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    const t = (vx - PAD.l) / plotW;
    return xMin + Math.max(0, Math.min(1, t)) * xSpan;
  }

  // How close (in viewBox x-units) the pointer must be to a band edge to grab it
  // instead of re-picking. Generous so both handles are easy to catch on touch.
  const GRAB_PX = 16;

  /** The band edge nearest the pointer, if within GRAB_PX — else null (a tap there
   *  re-picks instead). Disambiguates by raw pixel distance so the two handles are
   *  equally grabbable, even when the band is narrow. */
  function edgeNear(vx: number): 'lower' | 'higher' | null {
    if (!bandForThis) return null;
    const dLo = Math.abs(vx - cx(bandForThis.lower));
    const dHi = Math.abs(vx - cx(bandForThis.higher));
    if (Math.min(dLo, dHi) > GRAB_PX) return null;
    return dLo <= dHi ? 'lower' : 'higher';
  }

  /** Snap a dragged edge to the grid, keep lower < higher by ≥ one tick, and push
   *  the new band to the store (re-quotes downstream). `vx` is in viewBox units. */
  function applyDrag(edge: 'lower' | 'higher', vx: number) {
    if (!bandForThis) return;
    const t = (vx - PAD.l) / plotW;
    const p = xMin + Math.max(0, Math.min(1, t)) * xSpan;
    const { tickSize } = gridBounds(oracle);
    const lo = BigInt(bandForThis.lowerScaled);
    const hi = BigInt(bandForThis.higherScaled);
    let next = snapStrikeToTick(BigInt(Math.round(p * 1e9)), oracle);
    if (edge === 'lower') {
      if (next >= hi) next = snapStrikeToTick(hi - tickSize, oracle);
      setRangeBand({ ...bandForThis, lowerScaled: next.toString(), lower: toFloat(Number(next)) });
    } else {
      if (next <= lo) next = snapStrikeToTick(lo + tickSize, oracle);
      setRangeBand({ ...bandForThis, higherScaled: next.toString(), higher: toFloat(Number(next)) });
    }
  }

  /** Pointer x relative to the svg, in viewBox units (0..W). */
  function vxOf(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return ((e.clientX - rect.left) / rect.width) * W;
  }

  // The SVG owns every pointer interaction (one capture target, no paint-order
  // races): pressing on/near a band edge starts a drag; anywhere else hovers/picks.
  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    if (!rangeMode || !bandForThis) return;
    const vx = vxOf(e);
    const edge = edgeNear(vx);
    if (!edge) return; // not near a handle — fall through to hover/re-pick
    e.preventDefault();
    draggedRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragEdge(edge);
    setHoverPrice(null);
    applyDrag(edge, vx); // snap to the press point immediately — feels responsive
  }

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (dragEdge) {
      applyDrag(dragEdge, vxOf(e));
      return;
    }
    setHoverPrice(priceAt(e));
  }

  function onUp(e: React.PointerEvent<SVGSVGElement>) {
    if (!dragEdge) return;
    setDragEdge(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
  }

  /** In range mode, a click sets a band bound at the exact pointed price
   *  (snapped only to the $1 grid). */
  function onPick(e: React.PointerEvent<SVGSVGElement>) {
    if (!rangeMode) return;
    // Swallow the click that trails a band-edge drag so it doesn't re-anchor.
    if (draggedRef.current) {
      draggedRef.current = false;
      return;
    }
    const scaled = snapStrikeToTick(BigInt(Math.round(priceAt(e) * 1e9)), oracle);
    pickRangeStrike(
      {
        oracleId: oracle.oracle_id,
        expiry: oracle.expiry,
        strikeScaled: scaled.toString(),
        strike: toFloat(Number(scaled)),
      },
      'surface',
    );
  }

  // Live odds at the pointer — computed at the exact price, not read off a vertex.
  const hUp =
    hoverPrice != null ? upFair(hoverPrice, input.forward, input.svi, input.settlement ?? null) : null;
  // Show a resize cursor whenever the pointer is over a draggable band edge (or
  // mid-drag) so the affordance reads before the user even presses.
  const overEdge =
    !!dragEdge || (rangeMode && bandForThis != null && hoverPrice != null && edgeNear(cx(hoverPrice)) != null);
  // While placing the second range bound, the live chance of the band so far —
  // drag until it reads the odds you want.
  const liveRangeChance =
    rangeMode && anchorForThis && !bandForThis && hoverPrice != null
      ? rangeFair(
          Math.min(anchorForThis.strike, hoverPrice),
          Math.max(anchorForThis.strike, hoverPrice),
          input.forward,
          input.svi,
          input.settlement ?? null,
        )
      : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-text-3">
          Chance {asset} ends higher
          <InfoTip label="chance of ending higher">
            {`For each price level, the market's fair odds that ${asset} finishes above it by expiry. The odds drop as the price gets higher, and sit near 50% around today's price.`}
          </InfoTip>
        </span>
        {smile.hasButterfly ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-down">
            Prices look off ⚠
            <InfoTip label="prices look off">
              The odds should drop smoothly as the price rises. Here they tick back up somewhere,
              which doesn&apos;t add up (a free-money gap). On live data this almost never happens.
            </InfoTip>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-up">
            Prices look healthy ✓
            <InfoTip label="prices look healthy">
              The odds drop smoothly as the price rises — everything lines up, with no free-money
              gaps in the pricing.
            </InfoTip>
          </span>
        )}
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          className={`card block touch-none ${overEdge ? 'cursor-ew-resize' : 'cursor-crosshair'}`}
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerLeave={() => setHoverPrice(null)}
          onClick={onPick}
        >
          {/* 0 / 50 / 100% probability gridlines + axis labels (left edge) */}
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
              <text
                x={PAD.l + 1}
                y={sy(p) - 2}
                fill="var(--text-3)"
                fontSize={8}
                fontFamily="monospace"
              >
                {Math.round(p * 100)}%
              </text>
            </g>
          ))}
          {/* forward marker */}
          <line x1={fwdX} y1={PAD.t} x2={fwdX} y2={H - PAD.b} stroke="rgba(255,255,255,0.12)" />

          {/* range band — finalized shade (edge handles drawn on top, after the
              curve, below). Hit-testing for dragging lives on the <svg>. */}
          {rangeMode && bandForThis && (
            <rect
              x={cx(bandForThis.lower)}
              y={PAD.t}
              width={Math.max(0, cx(bandForThis.higher) - cx(bandForThis.lower))}
              height={plotH}
              fill="var(--up)"
              opacity={0.14}
            />
          )}
          {/* range anchor — first bound set, preview to the pointed price */}
          {rangeMode && !bandForThis && anchorForThis && (
            <>
              {hoverPrice != null && (
                <rect
                  x={Math.min(cx(anchorForThis.strike), cx(hoverPrice))}
                  y={PAD.t}
                  width={Math.abs(cx(hoverPrice) - cx(anchorForThis.strike))}
                  height={plotH}
                  fill="var(--up)"
                  opacity={0.08}
                />
              )}
              <line x1={cx(anchorForThis.strike)} y1={PAD.t} x2={cx(anchorForThis.strike)} y2={H - PAD.b} stroke="var(--up)" strokeWidth={1} opacity={0.7} strokeDasharray="3 2" />
            </>
          )}

          {/* binary selection — a crosshair to the picked strike */}
          {selForThis && (
            <line
              x1={cx(selForThis.strike)}
              y1={PAD.t}
              x2={cx(selForThis.strike)}
              y2={H - PAD.b}
              stroke="var(--accent)"
              strokeWidth={1}
              opacity={0.45}
            />
          )}

          <path d={path} fill="none" stroke="var(--up)" strokeWidth={1.5} />
          {butterflies.map((p) => (
            <circle key={p.strike} cx={sx(p.strike)} cy={sy(p.up)} r={2.5} fill="var(--down)" />
          ))}

          {/* draggable band edges — drawn on top of the curve so the grab handles
              are always visible. Pointer-events go to the <svg> (see onDown). */}
          {rangeMode &&
            bandForThis &&
            (['lower', 'higher'] as const).map((edge) => {
              const sval = edge === 'lower' ? bandForThis.lower : bandForThis.higher;
              const x = cx(sval);
              const active = dragEdge === edge;
              const pillH = 22;
              const pillY = PAD.t + plotH / 2 - pillH / 2;
              return (
                <g key={edge} pointerEvents="none">
                  <line
                    x1={x}
                    y1={PAD.t}
                    x2={x}
                    y2={H - PAD.b}
                    stroke="var(--up)"
                    strokeWidth={active ? 1.75 : 1}
                    opacity={active ? 1 : 0.75}
                  />
                  {/* grab pill with two grip lines — the obvious "drag me" affordance */}
                  <rect
                    x={x - 4}
                    y={pillY}
                    width={8}
                    height={pillH}
                    rx={4}
                    fill="var(--up)"
                    stroke="rgba(0,0,0,0.5)"
                    strokeWidth={0.75}
                    opacity={active ? 1 : 0.95}
                  />
                  <line x1={x - 1.5} y1={pillY + 6} x2={x - 1.5} y2={pillY + pillH - 6} stroke="rgba(0,0,0,0.45)" strokeWidth={0.75} />
                  <line x1={x + 1.5} y1={pillY + 6} x2={x + 1.5} y2={pillY + pillH - 6} stroke="rgba(0,0,0,0.45)" strokeWidth={0.75} />
                </g>
              );
            })}

          {/* selected market's chance — a level on the 0–100% axis (range = band
              chance, binary = the picked side's chance) */}
          {selChance != null && (
            <>
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
              <text
                x={W - PAD.r - 1}
                y={sy(selChance) - 3}
                fill="var(--accent)"
                fontSize={9}
                fontFamily="monospace"
                textAnchor="end"
              >
                {pct(selChance, 0)} chance
              </text>
            </>
          )}

          {/* hover guide + dot — rides the curve at the exact pointed price */}
          {hoverPrice != null && hUp != null && (
            <>
              <line x1={cx(hoverPrice)} y1={PAD.t} x2={cx(hoverPrice)} y2={H - PAD.b} stroke="var(--up)" strokeWidth={0.75} opacity={0.5} />
              <circle cx={cx(hoverPrice)} cy={sy(hUp)} r={3.5} fill="var(--up)" opacity={0.2} />
              <circle cx={cx(hoverPrice)} cy={sy(hUp)} r={2} fill="var(--up)" />
            </>
          )}
          {/* price axis labels (readable-band extents) */}
          <text x={PAD.l} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
            {price(xMin, 0)}
          </text>
          <text x={W - PAD.r} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace" textAnchor="end">
            {price(xMax, 0)}
          </text>
        </svg>

        {/* range mode — band summary / pick instruction + reset */}
        {rangeMode && (
          <div className="absolute left-1.5 top-1.5 z-10 flex items-center gap-1.5">
            <div className="glass pointer-events-none whitespace-nowrap rounded-md px-2 py-1 font-mono text-[10px] leading-none tabular-nums">
              {bandForThis ? (
                <span className="text-up">
                  {price(bandForThis.lower, 0)}–{price(bandForThis.higher, 0)}
                  {bandFair != null && <span className="text-text-3"> · {pct(bandFair, 0)} chance</span>}
                  <span className="text-text-3"> · drag edges</span>
                </span>
              ) : anchorForThis ? (
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
            {(bandForThis || anchorForThis) && (
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
            <div className="font-mono text-[11px] leading-none tabular-nums text-text-2">
              above {price(hoverPrice, 0)}
            </div>
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
          expected {price(smile.forward)}
          <InfoTip label="expected price">
            {`Where the market expects ${asset} to be at expiry (today's price carried forward). Right here, ending higher or lower is close to a coin flip.`}
          </InfoTip>
        </span>
        <span className="inline-flex items-center gap-1">
          ≈ 50/50 at {pct(atm, 1)} up
          <InfoTip label="the 50/50 point">
            Around the expected price, ending higher or lower is roughly even — about as close to a
            coin flip as this market gets.
          </InfoTip>
        </span>
      </div>
    </div>
  );
}

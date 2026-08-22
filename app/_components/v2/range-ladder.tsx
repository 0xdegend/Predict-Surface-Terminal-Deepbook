'use client';

/**
 * RangeLadder — the ticket's own horizontal range picker for range bets.
 *
 * Three parts, top → bottom:
 *   1. Live LOW / HIGH inputs — bound both ways: they show the current band, tick
 *      along as you drag, and editing one (Enter or blur) snaps to the grid and
 *      moves that end. Precise editor + always-on readout.
 *   2. A filled price strip — the strikes listed as a real scale (bright inside the
 *      band, dim outside), the in-band region tinted. A grabber sits on each end.
 *   3. A hint + the live band chance.
 *
 * While an end is being dragged (or keyboard-focused) a value pill pops at that
 * handle — the UP strike above, the DOWN strike below — for feedback right where
 * the finger is; idle, the handles stay clean and the inputs carry the numbers.
 * Every strike snaps to a real admission-grid strike, and price reads left→right
 * (matching the odds curve and the 3-D surface).
 *
 * This replaces the curve the ticket used to embed for range picking — the odds
 * curve now lives once, in the Odds tab. The band is owned by the trade store
 * (via `onChange`), so the two stay in sync. Drag/snap/framing mirror
 * V2SmileChart's band-edge logic, minus the SVG curve. See [[payout-slider]].
 */
import { useState } from 'react';
import { rangeFair, type SviFloat } from '@/lib/svi/svi';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { toFloat, fromFloat } from '@/config/scale';
import { price, pct } from '@/lib/format';

const W = 320;
const H = 46;
const PAD = { l: 12, r: 12 };
const BAND_Y = 6;
const BAND_H = 34;
const ROW_Y = BAND_Y + BAND_H / 2; // vertical centre of the strike scale
const GRAB_PX = 24; // how near (viewBox x) the pointer must be to grab an end
const fmtP = (s: number) => `$${price(s, 0)}`;

/** A LOW/HIGH field bound to a band edge: shows the live value when idle, holds a
 *  raw edit buffer while focused, and commits (snapped) on Enter/blur. */
function BoundField({
  label,
  value,
  onCommit,
  disabled,
}: {
  label: string;
  value: number;
  onCommit: (n: number) => void;
  disabled?: boolean;
}) {
  const [buf, setBuf] = useState<string | null>(null);
  const shown = buf ?? value.toLocaleString('en-US', { maximumFractionDigits: 0 });
  const commit = () => {
    if (buf != null) {
      const n = Number(buf.replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) onCommit(n);
    }
    setBuf(null);
  };
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1">
      {/* Kept for screen readers, hidden from the layout: two number boxes sitting left
          and right above a band picker describe themselves, and the eyebrow row cost a
          line of height to say so. */}
      <span className="sr-only">{label}</span>
      <div className="ctrl-soft flex items-center gap-1 rounded-md px-2 py-1.5 focus-within:border-white/20">
        <span className="text-[10px] text-text-3">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={shown}
          onChange={(e) => setBuf(e.target.value)}
          onFocus={(e) => {
            setBuf(String(Math.round(value)));
            e.currentTarget.select();
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
          disabled={disabled}
          aria-label={`${label} price`}
          className="w-full min-w-0 bg-transparent text-right font-mono tabular-nums text-text-1 outline-none placeholder:text-text-3/50"
        />
      </div>
    </label>
  );
}

export function RangeLadder({
  forward,
  svi,
  admStep,
  admissionTickSize,
  lower,
  higher,
  onChange,
  disabled,
  onReset,
}: {
  forward: number;
  svi: SviFloat;
  admStep: number;
  admissionTickSize: bigint;
  /** Optional Reset, rendered beside the LOW/HIGH fields. */
  onReset?: () => void;
  lower: number;
  higher: number;
  onChange: (lo: number, hi: number) => void;
  disabled?: boolean;
}) {
  // Which end is being dragged (state so the active end can highlight);
  // null = idle. `focus` mirrors it for keyboard use.
  const [drag, setDrag] = useState<'lower' | 'higher' | null>(null);
  const [focus, setFocus] = useState<'lower' | 'higher' | null>(null);
  // The x-window frozen at the start of a drag — reframing live would rescale the
  // scale every frame and make the end drift off the cursor (same fix as the curve).
  // State (not a ref) so the pinned frame drives rendering during the gesture.
  const [dragWin, setDragWin] = useState<{ min: number; max: number } | null>(null);

  const step = admStep || 1;
  const atm = toFloat(snapStrikeToAdmission(fromFloat(forward), admissionTickSize));
  const snap = (p: number) => toFloat(snapStrikeToAdmission(fromFloat(p), admissionTickSize));

  // Frame around the band with generous padding so there's room to drag the ends
  // outward within one gesture; pin the frame during a drag.
  let winMin: number;
  let winMax: number;
  if (drag && dragWin) {
    winMin = dragWin.min;
    winMax = dragWin.max;
  } else {
    const bandSpan = Math.max(higher - lower, step);
    const pad = Math.max(bandSpan * 0.9, step * 6, forward * 0.002);
    winMin = lower - pad;
    winMax = higher + pad;
  }
  // Floor the span so a near-expiry / tight band never collapses to a hairline.
  const MIN_WIN = Math.max(forward * 0.004, step * 12);
  if (winMax - winMin < MIN_WIN) {
    const mid = (winMin + winMax) / 2;
    winMin = mid - MIN_WIN / 2;
    winMax = mid + MIN_WIN / 2;
  }
  const xSpan = winMax - winMin;

  const plotW = W - PAD.l - PAD.r;
  const sx = (s: number) => PAD.l + ((s - winMin) / xSpan) * plotW;
  const cx = (s: number) => sx(Math.max(winMin, Math.min(winMax, s)));

  const chance = rangeFair(lower, higher, forward, svi);

  const xLo = cx(lower);
  const xHi = cx(higher);

  // The strike scale: real grid strikes across the window, thinned to a readable
  // increment (~6 marks). Skip the two the pills/inputs already show and any that
  // would sit under an end grabber. Bright inside the band, dim outside.
  const kStart = Math.ceil((winMin - atm) / step);
  const kEnd = Math.floor((winMax - atm) / step);
  const stopCount = Math.max(1, kEnd - kStart + 1);
  const labelEvery = Math.max(1, Math.round(stopCount / 6));
  const scale: { strike: number; x: number; inBand: boolean }[] = [];
  for (let k = kStart; k <= kEnd; k += labelEvery) {
    const strike = atm + k * step;
    if (Math.abs(strike - lower) < step * 0.5 || Math.abs(strike - higher) < step * 0.5) continue;
    const x = sx(strike);
    if (x < PAD.l + 6 || x > W - PAD.r - 6) continue;
    if (Math.abs(x - xLo) < 13 || Math.abs(x - xHi) < 13) continue; // clear of the grabbers
    scale.push({ strike, x, inBand: strike > lower && strike < higher });
  }

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
  /** The end nearest the pointer if within GRAB_PX, else the nearer of the two. */
  function nearestEdge(vx: number, requireGrab: boolean): 'lower' | 'higher' | null {
    const dLo = Math.abs(vx - cx(lower));
    const dHi = Math.abs(vx - cx(higher));
    if (requireGrab && Math.min(dLo, dHi) > GRAB_PX) return null;
    return dLo <= dHi ? 'lower' : 'higher';
  }
  /** Move one end to a pointed price, snapped, keeping the band ≥ one step wide. */
  function applyEdge(edge: 'lower' | 'higher', p: number) {
    const sp = snap(p);
    if (edge === 'lower') onChange(Math.min(sp, higher - step), higher);
    else onChange(lower, Math.max(sp, lower + step));
  }

  function onDown(e: React.PointerEvent<SVGSVGElement>) {
    if (disabled) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const vx = vxOf(e);
    // Grab the end under the pointer; if the tap is on open track, grab the nearer
    // end and move it there (tap-to-adjust).
    const edge = nearestEdge(vx, false)!;
    setDrag(edge);
    setFocus(edge);
    setDragWin({ min: winMin, max: winMax });
    applyEdge(edge, priceAt(e));
  }
  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    if (!drag) return;
    applyEdge(drag, priceAt(e));
  }
  function onUp(e: React.PointerEvent<SVGSVGElement>) {
    setDrag(null);
    setDragWin(null);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      /* capture may already be released */
    }
  }

  function onKey(edge: 'lower' | 'higher', e: React.KeyboardEvent) {
    if (disabled) return;
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    const cur = edge === 'lower' ? lower : higher;
    applyEdge(edge, cur + dir * step);
  }

  // The drag/focus value pill (HTML overlay, so the strip stays compact): UP strike
  // above the strip, DOWN strike below.
  const activeEdge = drag ?? focus;

  return (
    <div className="flex select-none flex-col gap-2.5">
      {/* live LOW / HIGH inputs (bound both ways), with Reset beside the values it
          resets — it used to share a row with an explainer that has since been cut. */}
      <div className="flex items-center gap-2">
        <BoundField label="Low" value={lower} onCommit={(n) => applyEdge('lower', n)} disabled={disabled} />
        <BoundField label="High" value={higher} onCommit={(n) => applyEdge('higher', n)} disabled={disabled} />
        {onReset && (
          <button
            type="button"
            onClick={onReset}
            className="ctrl-soft shrink-0 rounded-md px-2 py-1.5 text-[10px] font-medium uppercase tracking-wider text-text-3 transition-colors hover:text-text-1"
          >
            Reset
          </button>
        )}
      </div>

      {/* the price strip */}
      <div className={`relative ${disabled ? 'pointer-events-none opacity-50' : ''}`}>
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          className="card block touch-none select-none cursor-ew-resize"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          role="group"
          aria-label="Range price picker"
        >
          {/* faint cell separators (filmstrip texture) */}
          {scale.map((m) => (
            <line key={`s${m.strike}`} x1={m.x} y1={BAND_Y + 3} x2={m.x} y2={BAND_Y + BAND_H - 3} stroke="rgba(255,255,255,0.05)" strokeWidth={1} />
          ))}

          {/* today's price marker */}
          <line x1={cx(forward)} y1={BAND_Y + 2} x2={cx(forward)} y2={BAND_Y + BAND_H - 2} stroke="rgba(255,255,255,0.14)" strokeDasharray="2 3" />

          {/* the band — tinted glass panel + accent border + top sheen */}
          <rect x={xLo} y={BAND_Y} width={Math.max(0, xHi - xLo)} height={BAND_H} rx={6} fill="var(--up)" opacity={0.14} />
          <rect x={xLo} y={BAND_Y} width={Math.max(0, xHi - xLo)} height={BAND_H} rx={6} fill="none" stroke="var(--up)" strokeWidth={0.75} opacity={0.4} />
          <line x1={xLo + 3} y1={BAND_Y + 2} x2={xHi - 3} y2={BAND_Y + 2} stroke="rgba(255,255,255,0.10)" strokeWidth={0.75} />

          {/* the strike scale — bright inside the band, dim outside */}
          {scale.map((m) => (
            <text
              key={m.strike}
              x={m.x}
              y={ROW_Y + 3.2}
              fill={m.inBand ? 'var(--text-1)' : 'var(--text-3)'}
              fontSize={9}
              fontFamily="monospace"
              textAnchor="middle"
              opacity={m.inBand ? 0.95 : 0.7}
            >
              {price(m.strike, 0)}
            </text>
          ))}

          {/* end grabbers */}
          {(['lower', 'higher'] as const).map((edge) => {
            const x = edge === 'lower' ? xLo : xHi;
            const active = drag === edge || focus === edge;
            return (
              <g
                key={edge}
                tabIndex={disabled ? -1 : 0}
                role="slider"
                aria-label={`${edge === 'lower' ? 'Lower' : 'Upper'} price`}
                aria-valuemin={Math.round(winMin)}
                aria-valuemax={Math.round(winMax)}
                aria-valuenow={Math.round(edge === 'lower' ? lower : higher)}
                aria-valuetext={fmtP(edge === 'lower' ? lower : higher)}
                aria-disabled={disabled}
                onKeyDown={(e) => onKey(edge, e)}
                onFocus={() => setFocus(edge)}
                onBlur={() => setFocus((f) => (f === edge ? null : f))}
                style={{ outline: 'none', cursor: 'ew-resize' }}
              >
                {active && <rect x={x - 7} y={BAND_Y - 2} width={14} height={BAND_H + 4} rx={5} fill="none" stroke="var(--accent)" strokeWidth={1} opacity={0.75} />}
                <rect x={x - 4.5} y={BAND_Y - 1} width={9} height={BAND_H + 2} rx={4} fill="var(--up)" stroke="rgba(0,0,0,0.5)" strokeWidth={0.75} opacity={active ? 1 : 0.95} />
                <line x1={x - 1.5} y1={ROW_Y - 5} x2={x - 1.5} y2={ROW_Y + 5} stroke="rgba(0,0,0,0.4)" strokeWidth={0.75} />
                <line x1={x + 1.5} y1={ROW_Y - 5} x2={x + 1.5} y2={ROW_Y + 5} stroke="rgba(0,0,0,0.4)" strokeWidth={0.75} />
              </g>
            );
          })}
        </svg>

        {/* drag/focus value pill — pops at the active handle, above (up) / below (down) */}
        {activeEdge && (
          <div
            className="pointer-events-none absolute z-20 whitespace-nowrap rounded-md px-2 py-0.5 font-mono text-[11px] font-bold tabular-nums shadow-lg"
            style={{
              left: `${(cx(activeEdge === 'higher' ? higher : lower) / W) * 100}%`,
              [activeEdge === 'higher' ? 'top' : 'bottom']: 0,
              transform: `translate(-50%, ${activeEdge === 'higher' ? 'calc(-100% - 3px)' : 'calc(100% + 3px)'})`,
              background: 'var(--up)',
              color: '#0A0B0D',
            }}
          >
            {activeEdge === 'higher' ? '▲' : '▼'} {fmtP(activeEdge === 'higher' ? higher : lower)}
          </div>
        )}
      </div>

      {/* "drag or tap the handles" used to sit on the left. The handles carry grip marks
          and are the only interactive thing in the strip, so the instruction was only ever
          news once and cost a row forever. */}
      <div className="flex items-center justify-end font-mono text-[10px] tabular-nums text-text-3">
        <span className="text-up">≈ {pct(chance, 0)} chance in band</span>
      </div>
    </div>
  );
}

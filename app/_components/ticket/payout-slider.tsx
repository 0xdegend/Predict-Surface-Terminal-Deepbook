'use client';

/**
 * PayoutSlider — pick a binary bet by its PAYOUT, not its raw strike. The track
 * is bounded to the quotable band and centered on today's price (ATM), so every
 * position is a valid, priceable strike — no dead zones. Drag left for a safer,
 * smaller win; right for a riskier, bigger one. The exact strike + a $1 nudge
 * stay alongside for precision.
 *
 * Maps a slider position → the chosen direction's fair probability → the grid
 * strike that prices there (see lib/svi/invert). Re-derives from the live strike
 * each render, so the thumb tracks the forward as it moves.
 */
import { useRef, useState } from 'react';
import { upFair, type SviFloat } from '@/lib/svi/svi';
import { strikeForDirectionFair, payoutMultiple } from '@/lib/svi/invert';
import { gridBounds, snapStrikeToTick } from '@/lib/keys';
import { toFloat, fromFloat } from '@/config/scale';
import { price, num } from '@/lib/format';
import type { Oracle } from '@/lib/api/types';

// Slider band, in direction-fair probability. Left = safe (~1.07×), right =
// risky (~17×); ATM (50%) lands at the center.
const SAFE = 0.93;
const RISKY = 0.06;

export function PayoutSlider({
  oracle,
  forward,
  svi,
  settlement,
  isUp,
  strike,
  onChange,
  disabled = false,
}: {
  oracle: Oracle;
  forward: number;
  svi: SviFloat;
  settlement: number | null;
  isUp: boolean;
  strike: bigint;
  onChange: (s: bigint) => void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Typed-strike draft: null = not editing (show the live strike). Lets a user
  // type an exact strike instead of dragging; committed on Enter/blur.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const strikeFloat = toFloat(Number(strike));
  const up = upFair(strikeFloat, forward, svi, settlement);
  const dirFair = isUp ? up : 1 - up;
  const clamped = Math.min(SAFE, Math.max(RISKY, dirFair));
  const t = (SAFE - clamped) / (SAFE - RISKY); // 0 = safe/left … 1 = risky/right
  const atmT = (SAFE - 0.5) / (SAFE - RISKY);
  const multiple = payoutMultiple(dirFair);

  function setFromT(tt: number) {
    const cl = Math.min(1, Math.max(0, tt));
    const targetDir = SAFE + (RISKY - SAFE) * cl;
    onChange(strikeForDirectionFair(targetDir, forward, svi, oracle, isUp, settlement));
  }
  function setFromClientX(clientX: number) {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFromT((clientX - r.left) / r.width);
  }
  function onPointerDown(e: React.PointerEvent) {
    if (disabled) return;
    dragging.current = true;
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setFromClientX(e.clientX);
  }
  function onPointerMove(e: React.PointerEvent) {
    if (dragging.current && !disabled) setFromClientX(e.clientX);
  }
  function endDrag() {
    dragging.current = false;
  }
  function nudge(dir: number) {
    if (disabled) return;
    const { tickSize } = gridBounds(oracle);
    onChange(snapStrikeToTick(strike + BigInt(dir) * tickSize, oracle));
  }
  function commitDraft() {
    if (draft === null) return;
    const text = draft;
    setDraft(null); // idempotent — Enter then blur only commits once
    const parsed = parseFloat(text.replace(/,/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    // Snap the typed price onto the same grid the nudge uses.
    const snapped = snapStrikeToTick(fromFloat(parsed), oracle);
    if (snapped > 0n && snapped !== strike) onChange(snapped);
  }
  function onInputKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitDraft();
      e.currentTarget.blur();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setDraft(null); // cancel — revert to the live strike
      e.currentTarget.blur();
    }
  }
  function onKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      setFromT(t + 0.04);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      setFromT(t - 0.04);
    }
  }

  return (
    <div className="select-none">
      {/* readout — payout multiple + exact strike with a $1 nudge */}
      <div className="mb-2.5 flex items-end justify-between gap-2">
        <div>
          <div className="eyebrow text-text-3">Pick your strike</div>
          <div className="mt-0.5 font-mono text-[20px] font-semibold leading-none text-text-1">
            {multiple < 10 ? num(multiple, 1) : num(multiple, 0)}×{' '}
            <span className="text-[11px] font-normal text-text-3">if it hits</span>
          </div>
        </div>
        <div className="glass-inset inline-flex items-center gap-0.5 rounded-lg p-0.5">
          <button onClick={() => nudge(-1)} aria-label="Lower strike" className="ctrl-soft flex h-6 w-6 items-center justify-center rounded-md text-text-2">
            −
          </button>
          {/* Type an exact strike as an alternative to dragging. */}
          <input
            type="text"
            inputMode="decimal"
            aria-label="Strike price"
            disabled={disabled}
            value={editing ? draft : price(strikeFloat)}
            onFocus={(e) => {
              setDraft(String(strikeFloat));
              e.currentTarget.select();
            }}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitDraft}
            onKeyDown={onInputKey}
            className="w-24 rounded bg-transparent text-center font-mono text-[12px] text-text-1 outline-none focus-visible:ring-1 focus-visible:ring-accent disabled:opacity-50"
          />
          <button onClick={() => nudge(1)} aria-label="Raise strike" className="ctrl-soft flex h-6 w-6 items-center justify-center rounded-md text-text-2">
            +
          </button>
        </div>
      </div>

      {/* track */}
      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`relative h-9 touch-none ${disabled ? 'opacity-50' : 'cursor-pointer'}`}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-bg-3">
          <div className="h-full rounded-full bg-accent" style={{ width: `${t * 100}%`, opacity: 0.55 }} />
        </div>
        {/* today's-price (ATM) marker */}
        <div className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-white/25" style={{ left: `${atmT * 100}%` }} aria-hidden />
        {/* thumb */}
        <div
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="Payout"
          aria-valuemin={1}
          aria-valuemax={Math.round(payoutMultiple(RISKY))}
          aria-valuenow={Math.round(multiple * 10) / 10}
          aria-valuetext={`${num(multiple, 1)} times`}
          onKeyDown={onKey}
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-(--accent-line) bg-bg-1 outline-none ring-2 ring-(--accent-soft) transition-shadow focus-visible:ring-accent"
          style={{ left: `${t * 100}%` }}
        />
      </div>
    </div>
  );
}

'use client';

/**
 * V2LeverageSlider — continuous leverage picker (1× → the odds-scaled admission
 * cap), replacing the old whole-number preset buttons.
 *
 * The protocol admits ANY leverage from 1× up to `strike_exposure_config::
 * admitted_leverage_cap(entryProb)` (source-verified: it's continuous, not
 * stepped — see lib/sui/v2/quote.ts `admittedLeverageCap`). The old 1×/2×/3×
 * buttons both offered an impossible 3× (the cap only hits the market ceiling at
 * 100% odds) and hid the real headroom (2.7× at 50/50). This slider is bounded by
 * `leverageSliderMax`, so its max IS the live cap and it moves as the strike
 * changes. Same drag/keyboard UX + visual language as V2PayoutSlider.
 */
import { useRef } from 'react';
import { LEVERAGE_STEP } from '@/lib/sui/v2/quote';
import { leverage as fmtLev } from '@/lib/format';

export function V2LeverageSlider({
  value,
  max,
  onChange,
  tone = 'up',
  disabled = false,
}: {
  value: number;
  /** The odds-scaled admission cap (fractional, already on the 0.1× grid). */
  max: number;
  onChange: (leverage: number) => void;
  tone?: 'up' | 'down';
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const cap = Math.max(1, max);
  const lev = Math.min(Math.max(value, 1), cap);
  const span = cap - 1;
  const t = span > 0 ? (lev - 1) / span : 0;

  function snap(l: number): number {
    const stepped = Math.round(l / LEVERAGE_STEP) * LEVERAGE_STEP;
    return Math.min(cap, Math.max(1, Math.round(stepped * 10) / 10));
  }
  function setFromT(tt: number) {
    onChange(snap(1 + Math.min(1, Math.max(0, tt)) * span));
  }
  function setFromClientX(clientX: number) {
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setFromT((clientX - r.left) / r.width);
  }
  function onPointerDown(e: React.PointerEvent) {
    if (disabled || span <= 0) return;
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
  function onKey(e: React.KeyboardEvent) {
    if (disabled) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      onChange(snap(lev + LEVERAGE_STEP));
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      onChange(snap(lev - LEVERAGE_STEP));
    }
  }

  const fill = tone === 'up' ? 'bg-accent' : 'bg-down';
  const thumbRing = tone === 'up' ? 'ring-(--accent-soft) focus-visible:ring-accent border-(--accent-line)' : 'ring-(--down-soft) focus-visible:ring-down border-down/60';
  // Quick picks: 1×, 2× (only if admitted), and the live Max — deduped.
  const picks = [1, 2, cap].filter((v, i, a) => v <= cap && a.indexOf(v) === i);

  return (
    <div className="select-none">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] text-text-3">Leverage</span>
        <span className={`font-mono text-[15px] font-semibold tabular-nums ${lev > 1 ? (tone === 'up' ? 'text-accent' : 'text-down') : 'text-text-1'}`}>
          {fmtLev(lev)}
        </span>
      </div>

      <div
        ref={trackRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        className={`relative h-8 touch-none ${disabled || span <= 0 ? 'opacity-50' : 'cursor-pointer'}`}
      >
        <div className="absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-bg-3">
          <div className={`h-full rounded-full ${fill}`} style={{ width: `${t * 100}%`, opacity: 0.55 }} />
        </div>
        {/* 2× reference mark when it's within the admitted range */}
        {span > 0 && cap >= 2 && (
          <div
            className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-white/20"
            style={{ left: `${((2 - 1) / span) * 100}%` }}
            aria-hidden
          />
        )}
        <div
          role="slider"
          tabIndex={disabled || span <= 0 ? -1 : 0}
          aria-label="Leverage"
          aria-valuemin={1}
          aria-valuemax={Math.round(cap * 10) / 10}
          aria-valuenow={lev}
          aria-valuetext={fmtLev(lev)}
          onKeyDown={onKey}
          className={`absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border bg-bg-1 outline-none ring-2 transition-shadow ${thumbRing}`}
          style={{ left: `${t * 100}%` }}
        />
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2">
        <div className="flex gap-1">
          {picks.map((p) => {
            const active = Math.abs(lev - p) < LEVERAGE_STEP / 2;
            return (
              <button
                key={p}
                type="button"
                onClick={() => onChange(snap(p))}
                disabled={disabled}
                className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums transition-colors ${
                  active ? (tone === 'up' ? 'text-accent' : 'text-down') : 'ctrl-soft text-text-3'
                }`}
              >
                {p === cap && p !== 1 ? `Max ${fmtLev(p)}` : fmtLev(p)}
              </button>
            );
          })}
        </div>
        <span className="text-[9.5px] leading-tight text-text-3">higher odds unlock more</span>
      </div>
    </div>
  );
}

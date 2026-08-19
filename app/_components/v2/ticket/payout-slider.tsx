'use client';

/**
 * V2PayoutSlider — v2's strike picker, wired to v2's admission-tick grid
 * (lib/sui/v2/ticks.ts, lib/sui/v2/invert.ts). Reports an ABSOLUTE strike
 * (admission-grid price); the picked level is pinned and doesn't chase the forward.
 *
 * The control is framed around the decision a trader is actually making: how LIKELY
 * do I want this to hit, versus how big a payout. So the slider is a likelihood axis
 * (left = more likely / safer, right = longshot / bigger payout), the readout leads
 * with the CHANCE it hits (not an abstract payout multiple), and Safe/Even/Bold
 * presets give a one-tap pick. Pros still type an exact strike in the input. The
 * reward as real dollars shows at the Set Amount / review step, where it's concrete.
 * The thumb tracks the strike's live probability, so as the price moves the chance
 * updates while the pinned strike stays put.
 */
import { useRef, useState } from 'react';
import { upFair, type SviFloat } from '@/lib/svi/svi';
import { strikeForDirectionFair } from '@/lib/sui/v2/invert';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { toFloat, fromFloat } from '@/config/scale';

/** Strike display, whole dollars (no cents) — BTC strikes land on whole-dollar ticks. */
const fmtStrike = (v: number) => v.toLocaleString('en-US', { maximumFractionDigits: 0 });

// Slider band, in direction-fair probability. Left = safe (high chance), right =
// longshot (low chance); ATM (50%) lands at the center.
const SAFE = 0.93;
const RISKY = 0.06;

// One-tap picks, in direction-fair chance. Labels speak to the tradeoff, not a number.
const PRESETS: { label: string; dir: number }[] = [
  { label: 'Safe', dir: 0.75 },
  { label: 'Even', dir: 0.5 },
  { label: 'Bold', dir: 0.25 },
];
// How close the live chance must be to a preset for it to read as "selected".
const PRESET_SNAP = 0.03;

export function V2PayoutSlider({
  forward,
  svi,
  isUp,
  admStep,
  admissionTickSize,
  strike,
  onChange,
  disabled = false,
}: {
  forward: number;
  svi: SviFloat;
  isUp: boolean;
  /** Admission tick size (float dollars). */
  admStep: number;
  /** Admission tick size (1e9-scaled), for the inversion's grid snap. */
  admissionTickSize: bigint;
  /** Current absolute strike (admission-grid price). */
  strike: number;
  onChange: (strike: number) => void;
  disabled?: boolean;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  // Typed-strike draft: null = not editing (show the live strike). Lets a user
  // type an exact strike instead of dragging; committed on Enter/blur.
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  const strikeFloat = strike;
  const up = upFair(strikeFloat, forward, svi);
  const dirFair = isUp ? up : 1 - up; // chance this bet hits
  const clamped = Math.min(SAFE, Math.max(RISKY, dirFair));
  const t = (SAFE - clamped) / (SAFE - RISKY); // 0 = safe/left … 1 = risky/right
  const atmT = (SAFE - 0.5) / (SAFE - RISKY);
  const chancePct = Math.round(dirFair * 100);

  function strikeForTargetDir(targetDir: number): number {
    const s = strikeForDirectionFair(targetDir, forward, svi, admissionTickSize, isUp);
    return toFloat(Number(s));
  }
  function setFromT(tt: number) {
    const cl = Math.min(1, Math.max(0, tt));
    const targetDir = SAFE + (RISKY - SAFE) * cl;
    onChange(strikeForTargetDir(targetDir));
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
    onChange(strikeFloat + dir * admStep);
  }
  function commitDraft() {
    if (draft === null) return;
    const text = draft;
    setDraft(null); // idempotent — Enter then blur only commits once
    const parsed = parseFloat(text.replace(/,/g, ''));
    if (!Number.isFinite(parsed) || parsed <= 0) return;
    // Snap the typed price onto the admission grid, same grid the nudge uses.
    const snapped = toFloat(Number(snapStrikeToAdmission(fromFloat(parsed), admissionTickSize)));
    if (snapped > 0 && snapped !== strikeFloat) onChange(snapped);
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
      {/* readout — CHANCE it hits + exact strike with a ±1-tick nudge */}
      <div className="mb-2.5 flex items-end justify-between gap-2">
        <div>
          <div className="eyebrow text-text-3">Chance it hits</div>
          <div className="mt-0.5 font-mono text-[20px] font-semibold leading-none text-text-1">
            {chancePct}
            <span className="text-[13px] font-normal text-text-3">%</span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="eyebrow text-text-3">Strike</div>
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
              value={editing ? draft : fmtStrike(strikeFloat)}
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
      </div>

      {/* presets — one-tap safe / even / longshot picks */}
      <div className="mb-2.5 grid grid-cols-3 gap-1.5">
        {PRESETS.map((p) => {
          const active = Math.abs(dirFair - p.dir) <= PRESET_SNAP;
          return (
            <button
              key={p.label}
              type="button"
              disabled={disabled}
              onClick={() => onChange(strikeForTargetDir(p.dir))}
              aria-pressed={active}
              className={`rounded-lg border py-1.5 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                active
                  ? 'border-(--accent-line) bg-(--accent-soft) text-accent'
                  : 'border-line text-text-2 hover:border-white/20 hover:text-text-1'
              }`}
            >
              {p.label}
            </button>
          );
        })}
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
          aria-label="Chance it hits"
          aria-valuemin={Math.round(RISKY * 100)}
          aria-valuemax={Math.round(SAFE * 100)}
          aria-valuenow={chancePct}
          aria-valuetext={`${chancePct}% chance it hits`}
          onKeyDown={onKey}
          className="absolute top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full border border-(--accent-line) bg-bg-1 outline-none ring-2 ring-(--accent-soft) transition-shadow focus-visible:ring-accent"
          style={{ left: `${t * 100}%` }}
        />
      </div>

      {/* end labels — the tradeoff the axis represents, no number needed */}
      <div className="mt-1.5 flex items-center justify-between text-[10px] text-text-3">
        <span>More likely</span>
        <span>Bigger payout</span>
      </div>
    </div>
  );
}

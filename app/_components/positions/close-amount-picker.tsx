'use client';

import { quote as fmtQuote } from '@/lib/format';
import { fromQuote } from '@/config/scale';

const PRESETS = [25, 50, 75, 100] as const;

/**
 * Shared "Amount to close" selector for partial position closes (binary + range).
 * Preset chips (25 / 50 / 75 / Max) and an exact contract count, kept in sync and
 * clamped to the open lot. State lives in the parent modal; this is presentation
 * only, so both close flows can never drift apart.
 *
 * `openBase` is the full lot in on-chain base units (@6dec); `closeBase` is the
 * chosen amount; `onChange` reports new base-unit selections back to the parent.
 */
export function CloseAmountPicker({
  openBase,
  closeBase,
  onChange,
  lotBase,
}: {
  openBase: bigint;
  closeBase: bigint;
  onChange: (base: bigint) => void;
  /** Snap partial amounts DOWN onto this lot grid (base units). The chain rejects
   *  order quantities that aren't a whole number of lots (v2:
   *  `order::assert_valid_quantity`), so a raw 50%-of-an-odd-lot amount aborts —
   *  which surfaces as a gasless "create phase 400" (Enoki dry-runs at create).
   *  A full close still sends the exact open lot. Omit ⇒ no snapping (legacy). */
  lotBase?: bigint;
}) {
  const fraction = openBase > 0n ? Number(closeBase) / Number(openBase) : 0;
  const activePreset = PRESETS.find((pp) => Math.abs(fraction * 100 - pp) < 0.5) ?? null;
  const maxContracts = fromQuote(openBase);
  const closeContracts = fromQuote(closeBase);

  // A full close sends the exact open lot (already aligned, no dust left behind);
  // a partial floors onto the lot grid, never below one lot — so the redeem can
  // never carry a quantity the contract would reject.
  function snap(base: bigint): bigint {
    if (base >= openBase) return openBase;
    if (!lotBase || lotBase <= 0n) return base;
    const snapped = (base / lotBase) * lotBase;
    if (snapped > 0n) return snapped;
    return openBase < lotBase ? openBase : lotBase;
  }

  function setPct(pct: number) {
    onChange(pct >= 100 ? openBase : snap(BigInt(Math.floor(Number(openBase) * (pct / 100)))));
  }

  function setContracts(raw: string) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
      onChange(0n);
      return;
    }
    // contracts (human) → base units (1 contract = 1_000_000), snapped + clamped.
    onChange(snap(BigInt(Math.round(n * 1_000_000))));
  }

  return (
    <div className="glass-inset flex flex-col gap-3 p-4">
      <div className="flex items-center justify-between">
        <span className="eyebrow">Amount to close</span>
        <span className="font-mono text-[11px] tabular-nums text-text-2">
          {(fraction * 100).toFixed(fraction === 1 || fraction === 0 ? 0 : 1)}% of lot
        </span>
      </div>

      <div className="grid grid-cols-4 gap-1.5">
        {PRESETS.map((pp) => (
          <button
            key={pp}
            onClick={() => setPct(pp)}
            className={`rounded-md border px-2 py-1.5 font-mono text-[11px] tabular-nums transition-colors ${
              activePreset === pp
                ? 'border-(--accent-line) bg-(--accent-soft) text-up'
                : 'border-line text-text-2 hover:border-line-strong hover:text-text-1'
            }`}
          >
            {pp === 100 ? 'Max' : `${pp}%`}
          </button>
        ))}
      </div>

      <label className="flex items-center justify-between gap-3">
        <span className="text-[11px] text-text-3">Contracts</span>
        <span className="flex items-baseline gap-1.5">
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={maxContracts}
            step="any"
            value={closeContracts === 0 ? '' : Number(closeContracts.toFixed(6)).toString()}
            onChange={(e) => setContracts(e.target.value)}
            className="w-28 rounded-md border border-line bg-black/20 px-2 py-1.5 text-right font-mono text-[12px] tabular-nums text-text-1 focus:border-(--accent-line) focus:outline-none"
          />
          <span className="text-[10px] uppercase tracking-wider text-text-3">/ {fmtQuote(maxContracts)}</span>
        </span>
      </label>
    </div>
  );
}

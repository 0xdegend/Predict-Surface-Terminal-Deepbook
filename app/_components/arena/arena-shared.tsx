'use client';

/**
 * Shared primitives for the Degen Arena — the small, repeated bits (faction
 * glyph, rank medal, stat tile, pool cell) pulled out so the hub table, the
 * member detail, and the profile rail all speak the same visual language and
 * lean on the existing glass tokens (glass-inset, eyebrow, hairlines).
 */
import type { ReactNode } from 'react';
import type { IconType } from 'react-icons';
import { num, compact } from '@/lib/format';

// Gold / silver / bronze — same podium hues used by the leaderboard so a
// trader reads rank colour identically across the app.
export const RANK_HUE = ['#e8c14e', '#c2cbd4', '#c08a5a'];

/* ------------------------------------------------------------------ *
 * FactionGlyph — a tinted, rounded emblem carrying the faction's initial.
 * Stands in for the reference's per-faction logo without shipping images.
 * ------------------------------------------------------------------ */
export function FactionGlyph({ name, hue, size = 34 }: { name: string; hue: string; size?: number }) {
  const initial = name.replace(/^the\s+/i, '').charAt(0).toUpperCase();
  return (
    <span
      className="relative inline-flex flex-none items-center justify-center overflow-hidden rounded-xl font-semibold"
      style={{
        width: size,
        height: size,
        color: hue,
        background: `color-mix(in srgb, ${hue} 16%, transparent)`,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${hue} 32%, transparent)`,
        fontSize: Math.round(size * 0.44),
      }}
    >
      {/* faint top-lit sheen so the emblem reads as a lit chip, not a flat box */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-1/2"
        style={{ background: 'linear-gradient(180deg, rgba(255,255,255,0.14), transparent)' }}
      />
      <span className="relative">{initial}</span>
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * RankMedal — the leading rank cell. Top three get a coloured medal chip;
 * the rest a plain muted number.
 * ------------------------------------------------------------------ */
export function RankMedal({ rank }: { rank: number }) {
  const hue = RANK_HUE[rank - 1];
  if (hue) {
    return (
      <span
        className="inline-flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 font-mono text-[11px] font-semibold tabular-nums"
        style={{ color: hue, background: `color-mix(in srgb, ${hue} 15%, transparent)` }}
      >
        {rank}
      </span>
    );
  }
  return <span className="font-mono text-[12px] font-semibold tabular-nums text-text-3">{rank}</span>;
}

/* ------------------------------------------------------------------ *
 * StatTile — a glass-inset metric cell (eyebrow label + value), the unit
 * of the profile-rail grids. Optional icon chip + accent colour on the value.
 * ------------------------------------------------------------------ */
export function StatTile({
  label,
  value,
  unit,
  hue,
  icon: Icon,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  hue?: string;
  icon?: IconType;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-1.5 px-3 py-2.5">
      <span className="eyebrow inline-flex items-center gap-1.5">
        {Icon && <Icon size={11} style={{ color: hue ?? 'var(--text-3)' }} />}
        {label}
      </span>
      <span
        className="whitespace-nowrap font-mono text-[15px] leading-none tabular-nums"
        style={{ color: hue ?? 'var(--text-1)' }}
      >
        {value}
        {unit && <span className="ml-1 text-[10px] text-text-3">{unit}</span>}
      </span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * PoolCell — a right-aligned two-line prize cell: the DUSDC amount over a
 * small sub-figure (a share % or a live delta). Used for the Bonus/Base pool
 * columns in the hub table.
 * ------------------------------------------------------------------ */
export function PoolCell({
  amount,
  sub,
  subColor = 'var(--text-3)',
}: {
  amount: number;
  sub: ReactNode;
  subColor?: string;
}) {
  return (
    <span className="flex flex-col items-end gap-0.5 font-mono tabular-nums">
      <span className="text-[13px] leading-none text-text-1">
        {compact(amount)}
        <span className="ml-1 text-[9px] text-text-3">DUSDC</span>
      </span>
      <span className="text-[10px] leading-none" style={{ color: subColor }}>
        {sub}
      </span>
    </span>
  );
}

/** A small percentage rendered with fixed precision (share of pool etc.). */
export function sharePct(fraction: number, decimals = 2): string {
  return `${num(fraction * 100, decimals)}%`;
}

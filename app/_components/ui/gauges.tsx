'use client';

/**
 * Shared vault-risk gauges — a 270° radial dial and a linear meter. Extracted from
 * the legacy RiskPanel so the v2 risk panel renders identical instruments instead
 * of a second copy. Pure presentational: value in, arc out.
 */

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** A 270° radial gauge (gap centered at the bottom). `value` is a 0..1 fraction. */
export function RadialGauge({
  value,
  display,
  label,
  caption,
  color,
  size = 112,
}: {
  value: number;
  display: string;
  label: string;
  caption?: string;
  color: string;
  size?: number;
}) {
  const v = clamp01(value);
  const stroke = Math.round(size * 0.075);
  const r = size / 2 - stroke / 2 - 2;
  const c = 2 * Math.PI * r;
  const sweep = 0.75; // 270° arc, gap centered at the bottom
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} style={{ transform: 'rotate(135deg)' }} className="block">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="rgba(255,255,255,0.07)"
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${sweep * c} ${c}`}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={`${v * sweep * c} ${c}`}
            className="transition-[stroke-dasharray,stroke] duration-500 ease-out motion-reduce:transition-none"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="font-mono tabular-nums leading-none"
            style={{ color, fontSize: Math.round(size * 0.2) }}
          >
            {display}
          </span>
        </div>
      </div>
      <div className="flex flex-col items-center gap-0.5">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">{label}</span>
        {caption && <span className="font-mono text-[10px] tabular-nums text-text-2">{caption}</span>}
      </div>
    </div>
  );
}

/** A linear meter that turns coral past 85% of `max` (a saturation warning). */
export function Gauge({
  label,
  value,
  max,
  caption,
}: {
  label: string;
  value: number;
  max: number;
  caption: string;
}) {
  const frac = Math.max(0, Math.min(1, value / (max || 1)));
  const danger = frac > 0.85;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">{label}</span>
        <span className="font-mono text-[11px] tabular-nums text-text-2">{caption}</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/[0.05]">
        <div
          className={`h-full rounded-full transition-[width] duration-500 ease-out ${danger ? 'bg-down' : 'bg-up'}`}
          style={{ width: `${Math.max(frac * 100, 1.5)}%` }}
        />
      </div>
    </div>
  );
}

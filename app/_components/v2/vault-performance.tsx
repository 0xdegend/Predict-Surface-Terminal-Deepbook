'use client';

/**
 * V2VaultPerformance — the pool's price-per-share history, the read-side answer
 * to "is being an LP actually paying?". A self-contained responsive SVG line +
 * area over the flush series (see useVaultPerformance), with a hover readout and
 * a realized-LP-profit footnote. Additive; the on-chain overview is untouched.
 */
import { useState } from 'react';
import { LuTrendingUp } from 'react-icons/lu';
import { useVaultPerformance } from '@/lib/hooks/use-vault-performance';
import { predictV2Config } from '@/config/predict';
import { num, signed, dateUTC } from '@/lib/format';
import { HUE, IconChip } from '../ui/metric';

const W = 600;
const H = 150;
const PAD = 10;

export function V2VaultPerformance() {
  const { points, changePct, lpProfitTotal, settlements, loading } = useVaultPerformance();
  const [hover, setHover] = useState<number | null>(null);
  const sym = predictV2Config.quote.symbol;

  // Not enough history to draw a line yet — skeleton / quiet empty state.
  if (loading || points.length < 2) {
    return (
      <div className="glass-card flex flex-col gap-4 p-4">
        <Header />
        <div className="flex h-37.5 items-center justify-center rounded-lg bg-white/1.5 text-[11px] text-text-3">
          {loading ? 'Loading pool history…' : 'Not enough pool history yet — check back after a few updates.'}
        </div>
      </div>
    );
  }

  const prices = points.map((p) => p.price);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = max - min || max * 1e-4 || 1;
  const x = (i: number) => PAD + (i / (points.length - 1)) * (W - 2 * PAD);
  const y = (p: number) => H - PAD - ((p - min) / span) * (H - 2 * PAD);

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(2)},${y(p.price).toFixed(2)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(2)},${H} L${x(0).toFixed(2)},${H} Z`;

  const active = hover != null ? points[hover] : points[points.length - 1];
  const up = (changePct ?? 0) >= 0;
  const tone = up ? 'var(--up)' : 'var(--down)';

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    setHover(Math.round(frac * (points.length - 1)));
  }

  return (
    <div className="glass-card flex flex-col gap-3 p-4">
      <Header />

      {/* readout — hovered point, else latest */}
      <div className="flex items-end justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="eyebrow">Price per share</span>
          <span className="font-mono text-[22px] leading-none tabular-nums text-text-1">
            {num(active.price, 4)} <span className="text-[11px] text-text-3">{sym}</span>
          </span>
        </div>
        <div className="flex flex-col items-end gap-0.5">
          <span
            className="font-mono text-[13px] leading-none tabular-nums"
            style={{ color: tone }}
          >
            {changePct == null ? '—' : `${signed(changePct, 2)}%`}
          </span>
          <span className="text-[10px] text-text-3">
            {hover != null ? dateUTC(active.t) : 'over shown range'}
          </span>
        </div>
      </div>

      {/* chart */}
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="h-37.5 w-full touch-none"
        preserveAspectRatio="none"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="vaultPerfFill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={tone} stopOpacity="0.22" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#vaultPerfFill)" />
        <path d={line} fill="none" stroke={tone} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        {hover != null && (
          <>
            <line
              x1={x(hover)}
              y1={PAD}
              x2={x(hover)}
              y2={H - PAD}
              stroke="rgba(255,255,255,0.22)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
            <circle cx={x(hover)} cy={y(active.price)} r="3" fill={tone} vectorEffect="non-scaling-stroke" />
          </>
        )}
      </svg>

      {/* footnote — realized LP profit over the window */}
      <div className="flex items-center justify-between border-t border-line pt-2.5 text-[11px]">
        <span className="text-text-3">LP profit paid ({settlements} settlements)</span>
        <span className="font-mono tabular-nums" style={{ color: lpProfitTotal >= 0 ? 'var(--up)' : 'var(--down)' }}>
          {signed(lpProfitTotal, 2)} {sym}
        </span>
      </div>
    </div>
  );
}

function Header() {
  return (
    <div className="flex items-center gap-2.5">
      <IconChip icon={LuTrendingUp} color={HUE.teal} size={26} />
      <div className="flex flex-col">
        <h3 className="text-[14px] font-semibold tracking-tight text-text-1">Pool performance</h3>
        <span className="text-[10px] text-text-3">price per share · marked at each pool update</span>
      </div>
    </div>
  );
}

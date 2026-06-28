/**
 * V2Smile — a compact SVG of the market's fair odds of settling UP across the
 * strike grid (the readable slice of the vol surface). Computed server-side from
 * the live Pricer; falls as the strike rises and crosses ~50% near the forward.
 * No client JS. The math is lib/svi (mirrors the on-chain pricing).
 */
import { upFair, type SviFloat } from '@/lib/svi/svi';
import { toFloat } from '@/config/scale';

const W = 300;
const H = 84;
const PAD = { l: 6, r: 6, t: 8, b: 8 };

export function V2Smile({
  forward,
  svi,
  admissionTickScaled,
}: {
  forward: number;
  svi: SviFloat;
  admissionTickScaled: string;
}) {
  const step = toFloat(admissionTickScaled) || 1;
  // ±18 admission steps around the forward — wide enough to show the smile shape.
  const half = 18;
  const atm = Math.round(forward / step) * step;
  const pts: { x: number; up: number }[] = [];
  for (let i = -half; i <= half; i++) {
    pts.push({ x: i, up: upFair(atm + i * step, forward, svi) });
  }
  const innerW = W - PAD.l - PAD.r;
  const innerH = H - PAD.t - PAD.b;
  const sx = (i: number) => PAD.l + ((i + half) / (2 * half)) * innerW;
  const sy = (up: number) => PAD.t + (1 - up) * innerH; // up=1 at top
  const path = pts.map((p, k) => `${k === 0 ? 'M' : 'L'} ${sx(p.x).toFixed(1)} ${sy(p.up).toFixed(1)}`).join(' ');
  const midY = sy(0.5);
  const fwdX = sx(0);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Fair UP odds across strikes">
      {/* 50% guide */}
      <line x1={PAD.l} y1={midY} x2={W - PAD.r} y2={midY} stroke="var(--line)" strokeWidth="1" strokeDasharray="2 3" />
      {/* forward marker */}
      <line x1={fwdX} y1={PAD.t} x2={fwdX} y2={H - PAD.b} stroke="var(--line-soft)" strokeWidth="1" />
      {/* smile curve */}
      <path d={path} fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * 2-D smile strip — a compact SVG of fair UP price across the strike grid for one
 * expiry. Server component (static from the latest snapshot). Makes the SVI math
 * legible at a glance and visibly marks any butterfly violation (UP rising with
 * strike). The 3-D surface shows the whole thing; this is the readable cross-section.
 */
import { buildSmile, type SmileInput } from '@/lib/svi/surface';
import { price, pct } from '@/lib/format';

const W = 320;
const H = 120;
const PAD = { l: 8, r: 8, t: 10, b: 16 };

export function SmileStrip({ input }: { input: SmileInput }) {
  const smile = buildSmile(input, { half: 28 });
  const pts = smile.points;
  if (pts.length < 2) return null;

  const xs = pts.map((p) => p.strike);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = xMax - xMin || 1;

  // UP price is always in [0,1].
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const sx = (x: number) => PAD.l + ((x - xMin) / xSpan) * plotW;
  const sy = (up: number) => PAD.t + (1 - up) * plotH;

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.strike).toFixed(1)},${sy(p.up).toFixed(1)}`).join(' ');
  const fwdX = sx(Math.max(xMin, Math.min(xMax, smile.forward)));
  const butterflies = pts.filter((p) => p.butterfly);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">
          UP fair vs strike
        </span>
        {smile.hasButterfly ? (
          <span className="font-mono text-[10px] text-down">butterfly arb ⚠</span>
        ) : (
          <span className="font-mono text-[10px] text-up">no-arb ✓</span>
        )}
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} className="card">
        {/* 0.5 reference line */}
        <line x1={PAD.l} y1={sy(0.5)} x2={W - PAD.r} y2={sy(0.5)} stroke="rgba(255,255,255,0.06)" strokeDasharray="2 3" />
        {/* forward marker */}
        <line x1={fwdX} y1={PAD.t} x2={fwdX} y2={H - PAD.b} stroke="rgba(255,255,255,0.12)" />
        <path d={path} fill="none" stroke="var(--up)" strokeWidth={1.5} />
        {butterflies.map((p) => (
          <circle key={p.strike} cx={sx(p.strike)} cy={sy(p.up)} r={2.5} fill="var(--down)" />
        ))}
        {/* axis labels */}
        <text x={PAD.l} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
          {price(xMin, 0)}
        </text>
        <text x={W - PAD.r} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace" textAnchor="end">
          {price(xMax, 0)}
        </text>
      </svg>
      <div className="flex justify-between font-mono text-[10px] tabular-nums text-text-3">
        <span>fwd {price(smile.forward)}</span>
        <span>
          ATM UP {pct(smile.points[Math.floor(smile.points.length / 2)]?.up ?? 0, 1)}
        </span>
      </div>
    </div>
  );
}

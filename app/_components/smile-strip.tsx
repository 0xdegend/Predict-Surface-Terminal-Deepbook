'use client';

/**
 * Smile strip — a compact, INTERACTIVE chart of the market's fair odds of
 * settling UP across the price grid for one expiry. Hover (or drag on touch) to
 * read the odds at any price level. The curve falls as the price level rises
 * (harder to finish above a higher price); it crosses ~50% at the forward. Any
 * butterfly violation (odds rising with price — internally inconsistent) is
 * flagged. The 3-D surface shows the whole thing; this is the readable slice.
 */
import { useState } from 'react';
import { buildSmile, type SmileInput } from '@/lib/svi/surface';
import { price, pct } from '@/lib/format';
import { InfoTip } from './ui/info-tip';

const W = 320;
const H = 120;
const PAD = { l: 8, r: 8, t: 10, b: 16 };

export function SmileStrip({ input }: { input: SmileInput }) {
  const [hover, setHover] = useState<number | null>(null);
  const smile = buildSmile(input, { half: 28 });
  const pts = smile.points;
  if (pts.length < 2) return null;

  const xs = pts.map((p) => p.strike);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = xMax - xMin || 1;

  // UP price (fair odds) is always in [0,1].
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const sx = (x: number) => PAD.l + ((x - xMin) / xSpan) * plotW;
  const sy = (up: number) => PAD.t + (1 - up) * plotH;

  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${sx(p.strike).toFixed(1)},${sy(p.up).toFixed(1)}`).join(' ');
  const fwdX = sx(Math.max(xMin, Math.min(xMax, smile.forward)));
  const butterflies = pts.filter((p) => p.butterfly);
  const atm = smile.points[Math.floor(smile.points.length / 2)]?.up ?? 0;
  const asset = input.oracle.underlying_asset;

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(sx(pts[i].strike) - vx) < Math.abs(sx(pts[best].strike) - vx)) best = i;
    }
    setHover(best);
  }

  const hp = hover != null ? pts[hover] : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-text-3">
          Chance of finishing UP
          <InfoTip label="chance of finishing UP">
            For each price level, the market&apos;s fair odds that {asset} settles above it by expiry.
            It falls as the price level rises and crosses ~50% near the current price.
          </InfoTip>
        </span>
        {smile.hasButterfly ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-down">
            Pricing anomaly ⚠
            <InfoTip label="pricing anomaly">
              The odds should fall smoothly as the price level rises. Here they rise somewhere —
              internally inconsistent (an arbitrage). Normally this never happens on live data.
            </InfoTip>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-up">
            Healthy pricing ✓
            <InfoTip label="healthy pricing">
              Odds fall smoothly as the price level rises — internally consistent, with no risk-free
              arbitrage.
            </InfoTip>
          </span>
        )}
      </div>

      <div className="relative">
        <svg
          width="100%"
          viewBox={`0 0 ${W} ${H}`}
          className="card block cursor-crosshair touch-none"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {/* 50% reference line */}
          <line x1={PAD.l} y1={sy(0.5)} x2={W - PAD.r} y2={sy(0.5)} stroke="rgba(255,255,255,0.06)" strokeDasharray="2 3" />
          {/* forward marker */}
          <line x1={fwdX} y1={PAD.t} x2={fwdX} y2={H - PAD.b} stroke="rgba(255,255,255,0.12)" />
          <path d={path} fill="none" stroke="var(--up)" strokeWidth={1.5} />
          {butterflies.map((p) => (
            <circle key={p.strike} cx={sx(p.strike)} cy={sy(p.up)} r={2.5} fill="var(--down)" />
          ))}
          {/* hover guide + dot */}
          {hp && (
            <>
              <line x1={sx(hp.strike)} y1={PAD.t} x2={sx(hp.strike)} y2={H - PAD.b} stroke="var(--up)" strokeWidth={0.75} opacity={0.5} />
              <circle cx={sx(hp.strike)} cy={sy(hp.up)} r={3.5} fill="var(--up)" opacity={0.2} />
              <circle cx={sx(hp.strike)} cy={sy(hp.up)} r={2} fill="var(--up)" />
            </>
          )}
          {/* axis labels */}
          <text x={PAD.l} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace">
            {price(xMin, 0)}
          </text>
          <text x={W - PAD.r} y={H - 4} fill="var(--text-3)" fontSize={9} fontFamily="monospace" textAnchor="end">
            {price(xMax, 0)}
          </text>
        </svg>

        {/* hover readout — odds at the pointed price level */}
        {hp && (
          <div className="glass pointer-events-none absolute right-1.5 top-1.5 z-10 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-right">
            <div className="font-mono text-[11px] leading-none tabular-nums text-text-2">
              above {price(hp.strike, 0)}
            </div>
            <div className="mt-1 flex items-center justify-end gap-1.5 font-mono text-[11px] leading-none tabular-nums">
              <span className="text-up">{pct(hp.up, 0)} UP</span>
              <span className="text-text-3">·</span>
              <span className="text-down">{pct(1 - hp.up, 0)} DOWN</span>
            </div>
          </div>
        )}
      </div>

      <div className="flex justify-between font-mono text-[10px] tabular-nums text-text-3">
        <span>forward {price(smile.forward)}</span>
        <span className="inline-flex items-center gap-1">
          even-odds {pct(atm, 1)} UP
          <InfoTip label="even-odds (at-the-money)">
            At the price level nearest the forward, UP and DOWN are roughly 50/50 — the
            &ldquo;at-the-money&rdquo; point.
          </InfoTip>
        </span>
      </div>
    </div>
  );
}

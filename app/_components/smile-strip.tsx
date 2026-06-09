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
import { rangeFair } from '@/lib/svi/svi';
import { snapStrikeToTick } from '@/lib/keys';
import { toFloat } from '@/config/scale';
import { price, pct } from '@/lib/format';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { InfoTip } from './ui/info-tip';

const W = 320;
const H = 120;
const PAD = { l: 8, r: 8, t: 10, b: 16 };

export function SmileStrip({ input }: { input: SmileInput }) {
  const [hover, setHover] = useState<number | null>(null);
  const ticketMode = useSurfaceStore((s) => s.ticketMode);
  const pickRangeStrike = useSurfaceStore((s) => s.pickRangeStrike);
  const anchor = useSurfaceStore((s) => s.rangeAnchor);
  const band = useSurfaceStore((s) => s.rangeSelection);
  const smile = buildSmile(input, { half: 28 });
  const pts = smile.points;
  if (pts.length < 2) return null;

  const oracle = input.oracle;
  const rangeMode = ticketMode === 'range';
  const bandForThis = band && band.oracleId === oracle.oracle_id ? band : null;
  const anchorForThis = anchor && anchor.oracleId === oracle.oracle_id ? anchor : null;
  const bandFair = bandForThis
    ? rangeFair(bandForThis.lower, bandForThis.higher, input.forward, input.svi, input.settlement ?? null)
    : null;

  const xs = pts.map((p) => p.strike);
  const xMin = Math.min(...xs);
  const xMax = Math.max(...xs);
  const xSpan = xMax - xMin || 1;

  // UP price (fair odds) is always in [0,1].
  const plotW = W - PAD.l - PAD.r;
  const plotH = H - PAD.t - PAD.b;
  const sx = (x: number) => PAD.l + ((x - xMin) / xSpan) * plotW;
  const cx = (x: number) => sx(Math.max(xMin, Math.min(xMax, x))); // clamped to plot
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

  /** In range mode, a click sets a band bound at the nearest grid strike. */
  function onPick(e: React.PointerEvent<SVGSVGElement>) {
    if (!rangeMode) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const vx = ((e.clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < pts.length; i++) {
      if (Math.abs(sx(pts[i].strike) - vx) < Math.abs(sx(pts[best].strike) - vx)) best = i;
    }
    const scaled = snapStrikeToTick(BigInt(Math.round(pts[best].strike * 1e9)), oracle);
    pickRangeStrike({
      oracleId: oracle.oracle_id,
      expiry: oracle.expiry,
      strikeScaled: scaled.toString(),
      strike: toFloat(Number(scaled)),
    });
  }

  const hp = hover != null ? pts[hover] : null;

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-text-3">
          Chance {asset} ends higher
          <InfoTip label="chance of ending higher">
            {`For each price level, the market's fair odds that ${asset} finishes above it by expiry. The odds drop as the price gets higher, and sit near 50% around today's price.`}
          </InfoTip>
        </span>
        {smile.hasButterfly ? (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-down">
            Prices look off ⚠
            <InfoTip label="prices look off">
              The odds should drop smoothly as the price rises. Here they tick back up somewhere,
              which doesn&apos;t add up (a free-money gap). On live data this almost never happens.
            </InfoTip>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1 font-mono text-[10px] text-up">
            Prices look healthy ✓
            <InfoTip label="prices look healthy">
              The odds drop smoothly as the price rises — everything lines up, with no free-money
              gaps in the pricing.
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
          onClick={onPick}
        >
          {/* 50% reference line */}
          <line x1={PAD.l} y1={sy(0.5)} x2={W - PAD.r} y2={sy(0.5)} stroke="rgba(255,255,255,0.06)" strokeDasharray="2 3" />
          {/* forward marker */}
          <line x1={fwdX} y1={PAD.t} x2={fwdX} y2={H - PAD.b} stroke="rgba(255,255,255,0.12)" />

          {/* range band — finalized shade + bounds */}
          {rangeMode && bandForThis && (
            <>
              <rect
                x={cx(bandForThis.lower)}
                y={PAD.t}
                width={Math.max(0, cx(bandForThis.higher) - cx(bandForThis.lower))}
                height={plotH}
                fill="var(--up)"
                opacity={0.14}
              />
              {[bandForThis.lower, bandForThis.higher].map((s) => (
                <line key={s} x1={cx(s)} y1={PAD.t} x2={cx(s)} y2={H - PAD.b} stroke="var(--up)" strokeWidth={1} opacity={0.7} />
              ))}
            </>
          )}
          {/* range anchor — first bound set, preview to the hovered price */}
          {rangeMode && !bandForThis && anchorForThis && (
            <>
              {hp && (
                <rect
                  x={Math.min(cx(anchorForThis.strike), sx(hp.strike))}
                  y={PAD.t}
                  width={Math.abs(sx(hp.strike) - cx(anchorForThis.strike))}
                  height={plotH}
                  fill="var(--up)"
                  opacity={0.08}
                />
              )}
              <line x1={cx(anchorForThis.strike)} y1={PAD.t} x2={cx(anchorForThis.strike)} y2={H - PAD.b} stroke="var(--up)" strokeWidth={1} opacity={0.7} strokeDasharray="3 2" />
            </>
          )}
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

        {/* range mode — band summary or pick instruction */}
        {rangeMode && (
          <div className="glass pointer-events-none absolute left-1.5 top-1.5 z-10 whitespace-nowrap rounded-md px-2 py-1 font-mono text-[10px] leading-none tabular-nums">
            {bandForThis ? (
              <span className="text-up">
                {price(bandForThis.lower, 0)}–{price(bandForThis.higher, 0)}
                {bandFair != null && <span className="text-text-3"> · {pct(bandFair, 0)} chance</span>}
              </span>
            ) : anchorForThis ? (
              <span className="text-text-2">tap the upper price →</span>
            ) : (
              <span className="text-text-2">tap two prices to set a range</span>
            )}
          </div>
        )}

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
        <span className="inline-flex items-center gap-1">
          expected {price(smile.forward)}
          <InfoTip label="expected price">
            {`Where the market expects ${asset} to be at expiry (today's price carried forward). Right here, ending higher or lower is close to a coin flip.`}
          </InfoTip>
        </span>
        <span className="inline-flex items-center gap-1">
          ≈ 50/50 at {pct(atm, 1)} up
          <InfoTip label="the 50/50 point">
            Around the expected price, ending higher or lower is roughly even — about as close to a
            coin flip as this market gets.
          </InfoTip>
        </span>
      </div>
    </div>
  );
}

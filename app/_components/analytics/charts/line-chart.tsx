'use client';

/**
 * LineChart — the shared interactive area/line chart for the analytics tools
 * (visx). Gridlines + a left value axis + a crosshair tooltip on hover, plus
 * optional clickable nodes. `yScaleType="sqrt"` tames a single tall outlier (the
 * ultra-short market's huge price-swing) so the rest of the curve stays readable.
 * Width-filling; fixed height.
 */
import { useId, useState } from 'react';
import { Group } from '@visx/group';
import { LinePath, AreaClosed, Line } from '@visx/shape';
import { scaleLinear, scaleSqrt } from '@visx/scale';
import { GridRows } from '@visx/grid';
import { curveMonotoneX } from '@visx/curve';
import { localPoint } from '@visx/event';
import { ParentSize } from '@visx/responsive';

export interface ChartPoint {
  x: number;
  y: number;
  label: string; // x caption shown in the tooltip
}

interface Props {
  points: ChartPoint[];
  height?: number;
  color?: string;
  yFormat: (n: number) => string;
  yScaleType?: 'linear' | 'sqrt';
  xCaptions?: [string, string];
  showDots?: boolean;
  selectedIndex?: number;
  onPick?: (i: number) => void;
}

export function LineChart(props: Props) {
  return (
    <div style={{ height: props.height ?? 150 }}>
      <ParentSize>{({ width }) => (width > 0 ? <Inner {...props} width={width} /> : null)}</ParentSize>
    </div>
  );
}

function Inner({
  points,
  width,
  height = 150,
  color = 'var(--accent)',
  yFormat,
  yScaleType = 'linear',
  xCaptions,
  showDots = false,
  selectedIndex,
  onPick,
}: Props & { width: number }) {
  const gid = useId().replace(/[:]/g, '');
  const [hi, setHi] = useState<number | null>(null);
  const m = { top: 8, right: 12, bottom: 4, left: 36 };
  const iw = Math.max(0, width - m.left - m.right);
  const ih = Math.max(0, height - m.top - m.bottom);

  if (points.length < 2 || iw <= 0) return <svg width={width} height={height} />;

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const xScale = scaleLinear({ domain: [Math.min(...xs), Math.max(...xs)], range: [0, iw] });
  const yMin = Math.min(...ys);
  const yMax = Math.max(...ys);
  const make = yScaleType === 'sqrt' ? scaleSqrt : scaleLinear;
  const yScale = make({ domain: [Math.max(0, yMin * 0.95), yMax * 1.05], range: [ih, 0] });

  const px = (p: ChartPoint) => xScale(p.x);
  const py = (p: ChartPoint) => yScale(p.y);

  function onMove(e: React.PointerEvent<SVGSVGElement>) {
    const pt = localPoint(e);
    if (!pt) return;
    const vx = pt.x - m.left;
    let best = 0;
    for (let i = 1; i < points.length; i++) if (Math.abs(px(points[i]) - vx) < Math.abs(px(points[best]) - vx)) best = i;
    setHi(best);
  }

  const active = hi != null ? points[hi] : null;
  const ticks = yScale.ticks(3);

  return (
    <div className="relative">
      <svg
        width={width}
        height={height}
        className="touch-none cursor-crosshair"
        onPointerMove={onMove}
        onPointerLeave={() => setHi(null)}
      >
        <defs>
          <linearGradient id={`lc-${gid}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.16} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Group left={m.left} top={m.top}>
          <GridRows scale={yScale} width={iw} numTicks={3} stroke="rgba(255,255,255,0.05)" />
          {ticks.map((t) => (
            <text key={t} x={-7} y={yScale(t)} textAnchor="end" dominantBaseline="middle" fontSize={9} fontFamily="monospace" fill="var(--text-3)">
              {yFormat(t)}
            </text>
          ))}
          <AreaClosed data={points} x={px} y={py} yScale={yScale} curve={curveMonotoneX} fill={`url(#lc-${gid})`} stroke="transparent" />
          <LinePath data={points} x={px} y={py} curve={curveMonotoneX} stroke={color} strokeWidth={1.5} />
          {active && <Line from={{ x: px(active), y: 0 }} to={{ x: px(active), y: ih }} stroke={color} strokeWidth={0.75} opacity={0.4} />}
          {showDots &&
            points.map((p, i) => {
              const on = i === selectedIndex || i === hi;
              return (
                <g key={i} onClick={onPick ? () => onPick(i) : undefined} className={onPick ? 'cursor-pointer' : ''}>
                  <rect x={px(p) - 8} y={-m.top} width={16} height={height} fill="transparent" />
                  <circle cx={px(p)} cy={py(p)} r={on ? 4 : 2.5} fill={color} opacity={on ? 1 : 0.6} />
                  {i === selectedIndex && <circle cx={px(p)} cy={py(p)} r={7} fill="none" stroke={color} strokeWidth={1} opacity={0.4} />}
                </g>
              );
            })}
          {active && !showDots && <circle cx={px(active)} cy={py(active)} r={3} fill={color} />}
        </Group>
      </svg>

      {xCaptions && (
        <div className="mt-1 flex justify-between font-mono text-[10px] tabular-nums text-text-3" style={{ paddingLeft: m.left, paddingRight: m.right }}>
          <span>{xCaptions[0]}</span>
          <span>{xCaptions[1]}</span>
        </div>
      )}

      {active && (
        <div
          className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-md border border-line-soft bg-bg-2/95 px-2 py-1 font-mono text-[10px] tabular-nums text-text-1 shadow-lg"
          style={{ left: Math.min(Math.max(m.left + px(active), 44), width - 44), top: 0 }}
        >
          <span className="text-text-1">{yFormat(active.y)}</span>
          <span className="ml-1.5 text-text-3">{active.label}</span>
        </div>
      )}
    </div>
  );
}

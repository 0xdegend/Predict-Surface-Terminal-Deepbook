'use client';

/**
 * Sparkline — a tiny inline trend line (visx). Pure SVG, no axes, no interaction:
 * the at-a-glance "which way is this going" microchart used on KPI cells and
 * market rows. Auto-colors up/down from the series direction unless a color is
 * given. Fixed pixel size (sparklines live in tight cells).
 */
import { LinePath, AreaClosed } from '@visx/shape';
import { scaleLinear } from '@visx/scale';
import { curveMonotoneX } from '@visx/curve';
import { ParentSize } from '@visx/responsive';

export function Sparkline({
  data,
  width = 96,
  height = 28,
  color,
  area = true,
  strokeWidth = 1.4,
}: {
  data: number[];
  width?: number;
  height?: number;
  /** Override the auto up/down color. */
  color?: string;
  area?: boolean;
  strokeWidth?: number;
}) {
  if (data.length < 2) return <svg width={width} height={height} aria-hidden />;

  const stroke = color ?? (data[data.length - 1] >= data[0] ? 'var(--up)' : 'var(--down)');
  const yMin = Math.min(...data);
  const yMax = Math.max(...data);
  const PAD = 2;
  const xScale = scaleLinear({ domain: [0, data.length - 1], range: [PAD, width - PAD] });
  const yScale = scaleLinear({ domain: [yMin, yMax], range: [height - PAD, PAD] });

  const x = (_: number, i: number) => xScale(i);
  const y = (d: number) => yScale(d);
  const gradId = `spark-${Math.round(xScale(0) * 1000)}-${stroke.replace(/\W/g, '')}`;

  return (
    <svg width={width} height={height} aria-hidden className="overflow-visible">
      {area && (
        <defs>
          <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.22} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
      )}
      {area && (
        <AreaClosed
          data={data}
          x={x}
          y={y}
          yScale={yScale}
          curve={curveMonotoneX}
          fill={`url(#${gradId})`}
          stroke="transparent"
        />
      )}
      <LinePath data={data} x={x} y={y} curve={curveMonotoneX} stroke={stroke} strokeWidth={strokeWidth} />
      <circle cx={xScale(data.length - 1)} cy={yScale(data[data.length - 1])} r={1.8} fill={stroke} />
    </svg>
  );
}

/** Width-filling sparkline — for cells whose width isn't known ahead of time. */
export function ResponsiveSparkline({
  data,
  height = 36,
  color,
  area = true,
  strokeWidth = 1.4,
}: {
  data: number[];
  height?: number;
  color?: string;
  area?: boolean;
  strokeWidth?: number;
}) {
  return (
    <div style={{ width: '100%', height }}>
      <ParentSize>
        {({ width }) =>
          width > 0 ? (
            <Sparkline data={data} width={width} height={height} color={color} area={area} strokeWidth={strokeWidth} />
          ) : null
        }
      </ParentSize>
    </div>
  );
}

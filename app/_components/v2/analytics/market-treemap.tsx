'use client';

/**
 * V2MarketTreemap — the markets as a stock-heatmap treemap (visx), the v2 twin of
 * the legacy MarketTreemap. Tile SIZE ∝ the chosen metric (money bet / open bets /
 * price swing / sentiment) and COLOR ∝ crowd mood (green UP / red DOWN, stronger
 * when more one-sided). Active markets dominate; quiet ones shrink to slivers. Tap
 * a tile to bet its market.
 */
import { Group } from '@visx/group';
import { Treemap, hierarchy } from '@visx/hierarchy';
import { ParentSize } from '@visx/responsive';
import { metricValue, type GridMetric, type MarketCell } from '@/lib/analytics/v2-aggregate';
import { compact, num, pct, ttl } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';

const HEIGHT = 440;
/** Cap to the hottest markets so a long tail of quiet ones doesn't fill a corner
 *  with dead slivers — the Table view still lists every market. */
const MAX_TILES = 16;

interface LeafDatum {
  cell?: MarketCell;
  value?: number;
  children?: LeafDatum[];
}

function metricLabel(c: MarketCell, metric: GridMetric): string {
  switch (metric) {
    case 'volume':
      return `${compact(c.volume)}`;
    case 'oi':
      return `${compact(c.oi)}`;
    case 'iv':
      return pct(c.atmIv, 0);
    case 'sentiment':
      return `${Math.round((c.upShare >= 0.5 ? c.upShare : 1 - c.upShare) * 100)}%`;
  }
}

export function V2MarketTreemap({
  cells,
  metric,
  onTrade,
}: {
  cells: MarketCell[];
  metric: GridMetric;
  onTrade: (c: MarketCell) => void;
}) {
  return (
    <div style={{ height: HEIGHT }}>
      <ParentSize>
        {({ width }) =>
          width > 0 ? <TreemapInner width={width} height={HEIGHT} cells={cells} metric={metric} onTrade={onTrade} /> : null
        }
      </ParentSize>
    </div>
  );
}

function TreemapInner({
  width,
  height,
  cells,
  metric,
  onTrade,
}: {
  width: number;
  height: number;
  cells: MarketCell[];
  metric: GridMetric;
  onTrade: (c: MarketCell) => void;
}) {
  const now = useNow(0);

  const shown = [...cells].sort((a, b) => metricValue(b, metric) - metricValue(a, metric)).slice(0, MAX_TILES);
  const max = Math.max(0, ...shown.map((c) => metricValue(c, metric)));
  // Floor so quiet markets still read as real tiles, not slivers.
  const base = max > 0 ? max * 0.12 : 1;
  const data: LeafDatum = { children: shown.map((c) => ({ cell: c, value: metricValue(c, metric) + base })) };

  const root = hierarchy(data)
    .sum((d) => d.value ?? 0)
    .sort((a, b) => (b.value ?? 0) - (a.value ?? 0));

  return (
    <svg width={width} height={height}>
      <Treemap<LeafDatum> root={root} size={[width, height]} round paddingInner={3} paddingOuter={0}>
        {(treemap) => (
          <Group>
            {treemap.leaves().map((node, i) => {
              const c = node.data.cell;
              if (!c) return null;
              const w = node.x1 - node.x0;
              const h = node.y1 - node.y0;
              if (w < 2 || h < 2) return null;

              const leadUp = c.upShare >= 0.5;
              const strength = Math.abs(c.upShare - 0.5) * 2;
              const hue = leadUp ? 'var(--up)' : 'var(--down)';
              const fill = `color-mix(in srgb, ${hue} ${Math.round(12 + strength * 34)}%, var(--bg-3))`;
              const showText = w > 58 && h > 40;
              const showSub = w > 100 && h > 62;
              const clipId = `v2clip-${i}`;

              return (
                <Group key={`tile-${i}`} left={node.x0} top={node.y0}>
                  <defs>
                    <clipPath id={clipId}>
                      <rect width={w} height={h} rx={5} />
                    </clipPath>
                  </defs>
                  <rect
                    width={w}
                    height={h}
                    rx={5}
                    fill={fill}
                    stroke="rgba(255,255,255,0.08)"
                    strokeWidth={1}
                    className="cursor-pointer transition-[stroke] duration-150 hover:stroke-(--accent-line)"
                    onClick={() => onTrade(c)}
                  >
                    <title>{`BTC ${num(c.forward, 0)} · ends in ${ttl(c.expiry, now)} · ${metricLabel(c, metric)}`}</title>
                  </rect>
                  <g clipPath={`url(#${clipId})`} pointerEvents="none">
                    {showText && (
                      <text x={8} y={18} fill="var(--text-1)" fontSize={11} fontFamily="monospace">
                        BTC {num(c.forward, 0)}
                      </text>
                    )}
                    {showText && (
                      <text x={8} y={34} fill="var(--text-1)" fontSize={13} fontWeight={600} fontFamily="monospace">
                        {metricLabel(c, metric)}
                      </text>
                    )}
                    {showSub && (
                      <text x={8} y={h - 8} fill="var(--text-3)" fontSize={9.5} fontFamily="monospace">
                        {ttl(c.expiry, now)} · {Math.round((leadUp ? c.upShare : 1 - c.upShare) * 100)}% {leadUp ? 'UP' : 'DN'}
                      </text>
                    )}
                  </g>
                </Group>
              );
            })}
          </Group>
        )}
      </Treemap>
    </svg>
  );
}

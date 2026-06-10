'use client';

/**
 * Price chart — the "degen" counterpart to the 3-D vol surface. A live area
 * chart of the selected market's underlying (spot), with the user's selected
 * strike drawn as a dashed price line so a trader can watch price action against
 * their bet. Same live data as the surface (the public price tape); switching
 * views never refetches the protocol from scratch.
 *
 * lightweight-charts is DOM-only, so this is a client leaf mounted lazily by the
 * MarketView toggle — the chart bundle never loads until a user opens this view.
 */
import { useEffect, useRef } from 'react';
import {
  createChart,
  AreaSeries,
  LineStyle,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { getPriceHistory, getLatestPrices, qk } from '@/lib/api/client';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { useFrontOracleId } from '@/lib/hooks/use-front-oracle';
import { toFloat } from '@/config/scale';
import { price } from '@/lib/format';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle, PriceEvent } from '@/lib/api/types';

const UP = '#4dd6b0';
const DOWN = '#f0796b';

/** PriceEvent[] (newest-first) → ascending, one point per second (keep latest). */
function toSeries(events: PriceEvent[]): { time: UTCTimestamp; value: number }[] {
  const bySec = new Map<number, number>();
  for (const e of [...events].sort((a, b) => a.onchain_timestamp - b.onchain_timestamp)) {
    bySec.set(Math.floor(e.onchain_timestamp / 1000), toFloat(e.spot));
  }
  return [...bySec.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export function PriceChart({
  oracles,
  initialInputs,
}: {
  oracles: Oracle[];
  initialInputs: SmileInput[];
}) {
  const selection = useSurfaceStore((s) => s.selection);
  const frontId = useFrontOracleId(oracles[0]?.oracle_id ?? '');
  const activeId = selection?.oracleId ?? frontId;
  const activeOracle = oracles.find((o) => o.oracle_id === activeId) ?? oracles[0];
  const underlying = activeOracle?.underlying_asset ?? 'BTC';

  // Seed the live tape from the SSR snapshot for the front oracle (no blank flash).
  const seed = initialInputs.find((i) => i.oracle.oracle_id === activeId)?.forward;

  const historyQ = useQuery({
    queryKey: ['price-history', activeId],
    queryFn: ({ signal }) => getPriceHistory(activeId, 500, { signal }),
    enabled: !!activeId,
    staleTime: 5_000,
    refetchInterval: 20_000,
  });

  const latestQ = useQuery({
    queryKey: qk.latestPrices(activeId),
    queryFn: ({ signal }) => getLatestPrices(activeId, { signal }),
    enabled: !!activeId,
    refetchInterval: 1_000,
    placeholderData: keepPreviousData,
  });

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const lastTimeRef = useRef<number>(0);
  const fittedRef = useRef(false);

  // Create the chart once. autoSize handles resize via an internal ResizeObserver.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: 'transparent' },
        textColor: '#8b9099',
        fontFamily: 'var(--font-geist-mono), monospace',
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(255,255,255,0.035)' },
        horzLines: { color: 'rgba(255,255,255,0.035)' },
      },
      rightPriceScale: { borderColor: 'rgba(255,255,255,0.08)' },
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        vertLine: { color: 'rgba(255,255,255,0.18)', labelBackgroundColor: '#181c20' },
        horzLine: { color: 'rgba(255,255,255,0.18)', labelBackgroundColor: '#181c20' },
      },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: UP,
      topColor: 'rgba(77,214,176,0.22)',
      bottomColor: 'rgba(77,214,176,0)',
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: { type: 'price', precision: 0, minMove: 1 },
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      strikeLineRef.current = null;
    };
  }, []);

  // Switching oracle: reset the fit + last-time so the new series re-frames.
  useEffect(() => {
    fittedRef.current = false;
    lastTimeRef.current = 0;
  }, [activeId]);

  // Load / refresh the historical series.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !historyQ.data) return;
    const points = toSeries(historyQ.data);
    if (points.length === 0) return;
    series.setData(points);
    lastTimeRef.current = points[points.length - 1].time as number;
    if (!fittedRef.current) {
      chartRef.current?.timeScale().fitContent();
      fittedRef.current = true;
    }
  }, [historyQ.data]);

  // Append the live tick smoothly (update, not setData — no reflow/zoom reset).
  useEffect(() => {
    const series = seriesRef.current;
    const d = latestQ.data;
    if (!series || !d) return;
    const t = Math.floor(d.onchain_timestamp / 1000);
    if (t < lastTimeRef.current) return;
    series.update({ time: t as UTCTimestamp, value: toFloat(d.spot) });
    lastTimeRef.current = t;
  }, [latestQ.data]);

  // Draw the selected strike as a dashed price line (only for the active oracle).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (strikeLineRef.current) {
      series.removePriceLine(strikeLineRef.current);
      strikeLineRef.current = null;
    }
    if (selection && selection.oracleId === activeId) {
      strikeLineRef.current = series.createPriceLine({
        price: selection.strike,
        color: selection.isUp ? UP : DOWN,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `strike ${selection.isUp ? '▲' : '▼'}`,
      });
    }
  }, [selection, activeId]);

  const spot = latestQ.data ? toFloat(latestQ.data.spot) : seed ?? null;

  return (
    <div className="relative h-full w-full bg-bg-0">
      {/* Header — underlying + live spot, mirroring the surface's top-right label */}
      <div className="pointer-events-none absolute right-4 top-3 z-10 flex items-center gap-2">
        <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">
          {underlying}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">spot</span>
        <span className="font-mono text-[13px] tabular-nums text-text-1">
          {spot == null ? '—' : price(spot)}
        </span>
        <span className="live-dot" />
      </div>

      {!activeId || (historyQ.isError && !historyQ.data) ? (
        <div className="flex h-full items-center justify-center text-[12px] text-text-3">
          {historyQ.isError ? 'Could not load price history.' : 'No live market to chart.'}
        </div>
      ) : (
        <div ref={containerRef} className="h-full w-full" />
      )}
    </div>
  );
}

'use client';

/**
 * V2PriceChart — live BTC spot chart for the new deployment (the "Chart" hero
 * view, like legacy). lightweight-charts area series fed by the propbook Pyth
 * feed: history once, then live ticks appended ~1.5s. Self-contained; spot is the
 * same underlying for every market, so it's market-agnostic.
 */
import { useEffect, useRef } from 'react';
import {
  createChart,
  AreaSeries,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { getPythHistory, getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { predictV2Config } from '@/config/predict';
import type { PythObservation } from '@/lib/api/v2/types';

const UP = '#4dd6b0';
const PID = predictV2Config.asset.pythFeedId;

/** Observations → ascending {time, value}, one point per second (keep latest). */
function toSeries(obs: PythObservation[]): { time: UTCTimestamp; value: number }[] {
  const bySec = new Map<number, number>();
  for (const o of obs) {
    const v = pythSpot(o);
    const ts = o.checkpoint_timestamp_ms ?? o.source_timestamp_ms;
    if (v == null || ts == null) continue;
    bySec.set(Math.floor(ts / 1000), v);
  }
  return [...bySec.entries()].sort((a, b) => a[0] - b[0]).map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export function V2PriceChart() {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const lastTimeRef = useRef(0);

  const historyQ = useQuery({ queryKey: qkV2.pythHistory, queryFn: () => getPythHistory(PID, 300), refetchInterval: 30_000 });
  const latestQ = useQuery({ queryKey: qkV2.pythLatest, queryFn: () => getPythLatest(PID), refetchInterval: 1500 });

  // Create the chart once.
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
      timeScale: { borderColor: 'rgba(255,255,255,0.08)', timeVisible: true, secondsVisible: false, rightOffset: 6 },
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
    };
  }, []);

  // Seed / backfill history.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !historyQ.data) return;
    const points = toSeries(historyQ.data);
    if (!points.length) return;
    series.setData(points);
    lastTimeRef.current = points[points.length - 1].time as number;
    chartRef.current?.timeScale().fitContent();
  }, [historyQ.data]);

  // Append the live tick (update, not setData — no zoom reset).
  useEffect(() => {
    const series = seriesRef.current;
    const d = latestQ.data;
    if (!series || !d) return;
    const v = pythSpot(d);
    const ts = d.checkpoint_timestamp_ms ?? d.source_timestamp_ms;
    if (v == null || ts == null) return;
    const t = Math.floor(ts / 1000);
    if (t < lastTimeRef.current) return; // can't update an older bar
    series.update({ time: t as UTCTimestamp, value: v });
    lastTimeRef.current = t;
  }, [latestQ.data]);

  return <div ref={containerRef} className="h-full w-full" />;
}

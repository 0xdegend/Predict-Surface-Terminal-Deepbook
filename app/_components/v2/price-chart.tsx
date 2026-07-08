'use client';

/**
 * V2PriceChart — live BTC spot chart for the new deployment (the "Chart" hero
 * view, like legacy). lightweight-charts area series fed by the propbook Pyth
 * feed: history once, then live ticks appended ~1.5s.
 *
 * Mirrors legacy PriceChart's selection overlays: the ticket's strike renders
 * as a dashed price line ("strike ▲/▼") with the winning side shaded (UP =
 * above, DOWN = below), and range mode renders the shaded band between the two
 * edges — all live off the v2 trade store, so dragging the payout slider or the
 * odds curve moves the line/band in real time. The strike/band is resolved
 * against the selected market's admission grid (ATM from the live pricer).
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
  type AutoscaleInfo,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { PriceBandPrimitive, WinZonePrimitive } from '@/app/_components/chart/price-overlays';
import { getPythHistory, getPythLatest, pythSpot, qkV2 } from '@/lib/api/v2/client';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { toFloat, fromFloat } from '@/config/scale';
import { price } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import type { PythObservation, V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const UP = '#4dd6b0';
const DOWN = '#f0796b';
const PID = predictV2Config.asset.pythFeedId;

/**
 * Observations → ascending {time, value} at FULL sub-second resolution — one
 * point per Pyth tick (~2.4/sec), timed in fractional seconds.
 *
 * The old code collapsed the stream to one point per second, leaving the line
 * sparse (~130 points) so straight-line segments read as angular "cut edges";
 * an EWMA fix then over-smoothed it into a flat, low-volatility-looking line.
 * The real cause was density: legacy's chart draws ~500 points, so its segments
 * are tiny and the line reads smooth AND detailed. lightweight-charts accepts
 * fractional-second timestamps, so we keep every tick (deduped by exact time) —
 * the density itself makes the line smooth while preserving true price action.
 */
function toSeries(obs: PythObservation[]): { time: UTCTimestamp; value: number }[] {
  const byTime = new Map<number, number>();
  for (const o of obs) {
    const v = pythSpot(o);
    const ts = o.checkpoint_timestamp_ms ?? o.source_timestamp_ms;
    if (v == null || ts == null) continue;
    byTime.set(ts / 1000, v); // fractional seconds — full tick resolution
  }
  return [...byTime.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

export function V2PriceChart({
  market,
  pricer,
}: {
  /** Selected market (admission grid for strike resolution); overlays hidden when absent. */
  market?: V2Market | null;
  /** Its live pricer (ATM anchor); overlays hidden while loading. */
  pricer?: LivePricer;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Area'> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const bandRef = useRef<PriceBandPrimitive | null>(null);
  const winZoneRef = useRef<WinZonePrimitive | null>(null);
  // Selection extents, read by the series' autoscaleInfoProvider so the price
  // scale always frames the strike line / band (with padding) even when the
  // pick sits away from spot. Refs so the provider closure sees the latest.
  const strikeRangeRef = useRef<number | null>(null);
  const bandRangeRef = useRef<{ low: number; high: number } | null>(null);
  const lastTimeRef = useRef(0);
  // Fit + snap-to-live only on the first history load, so later refetches don't
  // yank the user's zoom/scroll back.
  const fittedRef = useRef(false);

  // Ticket selection → absolute prices on the chart.
  const mode = useV2TradeStore((s) => s.mode);
  const isUp = useV2TradeStore((s) => s.isUp);
  const strikeOffset = useV2TradeStore((s) => s.strikeOffset);
  const rangeLowerOffset = useV2TradeStore((s) => s.rangeLowerOffset);
  const rangeHigherOffset = useV2TradeStore((s) => s.rangeHigherOffset);

  const admStep = market ? toFloat(market.admission_tick_size) || 1 : null;
  const atm =
    market && pricer
      ? toFloat(snapStrikeToAdmission(fromFloat(pricer.forward), BigInt(market.admission_tick_size)))
      : null;
  const strike = atm != null && admStep != null && mode === 'binary' ? atm + strikeOffset * admStep : null;
  const bandLow =
    atm != null && admStep != null && mode === 'range' && rangeLowerOffset != null ? atm + rangeLowerOffset * admStep : null;
  const bandHigh =
    atm != null && admStep != null && mode === 'range' && rangeHigherOffset != null ? atm + rangeHigherOffset * admStep : null;

  // 500 = the propbook API's cap (~3.6 min of ticks) → a dense, legacy-count line.
  const historyQ = useQuery({ queryKey: qkV2.pythHistory, queryFn: () => getPythHistory(PID, 500), refetchInterval: 30_000 });
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
      // Extend the auto-scale to include the selected strike/band so it's always
      // framed (with padding) — even if the pick sits away from current spot.
      autoscaleInfoProvider: (baseImpl: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const base = baseImpl();
        const band = bandRangeRef.current;
        const s = strikeRangeRef.current;
        let lo: number | null = null;
        let hi: number | null = null;
        if (band) {
          const pad = Math.max((band.high - band.low) * 0.25, 1);
          lo = band.low - pad;
          hi = band.high + pad;
        }
        if (s != null) {
          const span = base?.priceRange ? base.priceRange.maxValue - base.priceRange.minValue : s * 0.01;
          const pad = Math.max(span * 0.08, 1);
          lo = lo == null ? s - pad : Math.min(lo, s - pad);
          hi = hi == null ? s + pad : Math.max(hi, s + pad);
        }
        if (lo == null || hi == null) return base;
        if (!base?.priceRange) return { priceRange: { minValue: lo, maxValue: hi } };
        return {
          ...base,
          priceRange: {
            minValue: Math.min(base.priceRange.minValue, lo),
            maxValue: Math.max(base.priceRange.maxValue, hi),
          },
        };
      },
    });
    // Range-band highlight + binary win-zone shade, attached once and driven by
    // the selection effect below.
    const band = new PriceBandPrimitive();
    series.attachPrimitive(band);
    const winZone = new WinZonePrimitive();
    series.attachPrimitive(winZone);

    chartRef.current = chart;
    seriesRef.current = series;
    bandRef.current = band;
    winZoneRef.current = winZone;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      strikeLineRef.current = null;
      bandRef.current = null;
      winZoneRef.current = null;
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
    if (!fittedRef.current) {
      chartRef.current?.timeScale().fitContent();
      // Snap to the live edge so the newest tick shows with the rightOffset gap
      // (fitContent alone pins the last point flush against the axis) — legacy parity.
      chartRef.current?.timeScale().scrollToRealTime();
      fittedRef.current = true;
    }
  }, [historyQ.data]);

  // Append the live tick (update, not setData — no zoom reset), at full
  // sub-second resolution so it continues the dense history line seamlessly.
  useEffect(() => {
    const series = seriesRef.current;
    const d = latestQ.data;
    if (!series || !d) return;
    const v = pythSpot(d);
    const ts = d.checkpoint_timestamp_ms ?? d.source_timestamp_ms;
    if (v == null || ts == null) return;
    const t = ts / 1000; // fractional seconds — same resolution as the history
    if (t < lastTimeRef.current) return; // can't update an older point
    series.update({ time: t as UTCTimestamp, value: v });
    lastTimeRef.current = t;
  }, [latestQ.data]);

  // Draw the ticket's selection: binary = dashed strike line + win-zone shade;
  // range = the shaded band between the edges. Tracks the store live.
  useEffect(() => {
    const series = seriesRef.current;
    const band = bandRef.current;
    const winZone = winZoneRef.current;
    if (!series || !band || !winZone) return;

    if (strikeLineRef.current) {
      series.removePriceLine(strikeLineRef.current);
      strikeLineRef.current = null;
    }

    if (strike != null) {
      strikeLineRef.current = series.createPriceLine({
        price: strike,
        color: isUp ? UP : DOWN,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `strike ${isUp ? '▲' : '▼'}`,
      });
      winZone.setZone(strike, isUp);
    } else {
      winZone.setZone(null, true);
    }
    strikeRangeRef.current = strike;

    band.setBand(bandLow, bandHigh);
    bandRangeRef.current = bandLow != null && bandHigh != null ? { low: bandLow, high: bandHigh } : null;

    // Reframe so the selection is in view; runs only on selection changes, so
    // it doesn't fight the user's zoom mid-view.
    series.priceScale().setAutoScale(true);
  }, [strike, isUp, bandLow, bandHigh]);

  // Live spot readout top-right (raw latest, matching the nav tape) — mirrors
  // legacy's "BTC SPOT" chart label.
  const spot = latestQ.data ? pythSpot(latestQ.data) : (pricer?.forward ?? null);

  return (
    <div className="relative h-full w-full bg-bg-0">
      <div className="pointer-events-none absolute right-4 top-3 z-10 flex items-center gap-2">
        <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">BTC</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">spot</span>
        <span className="font-mono text-[13px] tabular-nums text-text-1">{spot == null ? '—' : price(spot)}</span>
      </div>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}

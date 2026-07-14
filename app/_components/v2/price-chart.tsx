'use client';

/**
 * V2PriceChart — live BTC spot chart for the new deployment (the "Chart" hero
 * view, like legacy). lightweight-charts area series fed by the propbook Pyth
 * feed: history once, then live ticks appended ~1.5s.
 *
 * Mirrors legacy PriceChart's selection overlays: the ticket's strike renders
 * as a dashed price line ("strike ▲/▼") with the winning side shaded (UP =
 * above, DOWN = below), and range mode renders the shaded band between the two
 * edges — marked with labeled "range start" / "range end" lines so the exact
 * bounds read off the price axis, plus a lone "range start" line while only the
 * first edge is picked. All live off the v2 trade store, so dragging the payout
 * slider or the odds curve moves the line/band in real time. The strike/band is
 * resolved against the selected market's admission grid (ATM from the live pricer).
 */
import { useEffect, useRef } from 'react';
import {
  createChart,
  AreaSeries,
  LineStyle,
  LineType,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type AutoscaleInfo,
  type UTCTimestamp,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { PriceBandPrimitive, WinZonePrimitive, BAND_LINE } from '@/app/_components/chart/price-overlays';
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
 * A single, consistent timestamp (ms) for an observation. Prefer Pyth's own
 * publish time (`source_timestamp_ms`) — the price's real market time — and only
 * fall back to the Sui-checkpoint time. Picking ONE clock per point matters:
 * the two are offset from each other, so mixing them across the series makes
 * points interleave out of order and tears the line into vertical cliffs.
 */
function obsMs(o: PythObservation): number | null {
  return o.source_timestamp_ms ?? o.checkpoint_timestamp_ms ?? null;
}

/**
 * Observations → ascending {time, value}, ONE point per second (last value in
 * the second wins). Legacy parity (see chart/price-chart.tsx): per-second
 * decimation rejects the feed's sub-second noise — bid/ask flip, multi-publisher
 * jitter, momentary outliers — which otherwise renders as a jagged zig-zag AND
 * makes the price scale constantly re-expand and snap back. BTC moves only a few
 * dollars per second, so the resulting ~1/sec line is both smooth and honest.
 */
function toSeries(obs: PythObservation[]): { time: UTCTimestamp; value: number }[] {
  const bySec = new Map<number, number>();
  // Sort by full ms so, within a second, the chronologically LAST tick wins.
  for (const o of [...obs].sort((a, b) => (obsMs(a) ?? 0) - (obsMs(b) ?? 0))) {
    const v = pythSpot(o);
    const ms = obsMs(o);
    if (v == null || ms == null) continue;
    bySec.set(Math.floor(ms / 1000), v);
  }
  return [...bySec.entries()]
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
  // Labeled dashed lines that mark where the range starts and ends (and, while the
  // band is still open, the lone first-pick anchor) — so the exact edge prices read
  // off the price axis, not just the shaded band.
  const anchorLineRef = useRef<IPriceLine | null>(null);
  const lowerLineRef = useRef<IPriceLine | null>(null);
  const higherLineRef = useRef<IPriceLine | null>(null);
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
  const strikePrice = useV2TradeStore((s) => s.strikePrice);
  const rangeLowerPrice = useV2TradeStore((s) => s.rangeLowerPrice);
  const rangeHigherPrice = useV2TradeStore((s) => s.rangeHigherPrice);
  // First-picked edge while a band is being built (null once both edges are set,
  // or in binary mode) — drives the "range start" line before the band closes.
  const rangeAnchorPrice = useV2TradeStore((s) => s.rangeAnchorPrice);

  const atm =
    market && pricer
      ? toFloat(snapStrikeToAdmission(fromFloat(pricer.forward), BigInt(market.admission_tick_size)))
      : null;
  // Absolute strikes (pinned); the binary line defaults to ATM until a level is picked.
  const strike = atm != null && mode === 'binary' ? strikePrice ?? atm : null;
  const bandLow = mode === 'range' ? rangeLowerPrice : null;
  const bandHigh = mode === 'range' ? rangeHigherPrice : null;
  // The lone first-pick level, shown while the band is still open (range mode only).
  const anchor = mode === 'range' ? rangeAnchorPrice : null;

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
      // secondsVisible is set ADAPTIVELY after history loads (see below): a short,
      // fast window collapses HH:MM labels into duplicates ("10:32 10:32 10:32"),
      // so it shows seconds; a legacy-length window keeps clean minute labels.
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
      // Curved interpolation rounds the corners into a smooth spline (vs the
      // default straight-segment line) — the softer "flowing" look. Purely a
      // render choice; the line still passes through every real data point.
      lineType: LineType.Curved,
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
      anchorLineRef.current = null;
      lowerLineRef.current = null;
      higherLineRef.current = null;
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
    // Adapt the axis labels to the actual window: minute labels read cleanest
    // (legacy parity), but collapse to duplicates once ticks fall closer than a
    // minute apart — so only show seconds when the window is short (< ~8 min,
    // the common case at the feed's 500-tick cap).
    const span = (points[points.length - 1].time as number) - (points[0].time as number);
    chartRef.current?.applyOptions({ timeScale: { secondsVisible: span < 8 * 60 } });
    if (!fittedRef.current) {
      chartRef.current?.timeScale().fitContent();
      // Snap to the live edge so the newest tick shows with the rightOffset gap
      // (fitContent alone pins the last point flush against the axis) — legacy parity.
      chartRef.current?.timeScale().scrollToRealTime();
      fittedRef.current = true;
    }
  }, [historyQ.data]);

  // Append the live tick (update, not setData — no zoom reset). Same per-second
  // bucket + single clock as the history, so an intra-second tick REPLACES the
  // current second's point (smooth live edge) and each new second advances it —
  // legacy parity. Sub-second resolution here is what caused the jitter.
  useEffect(() => {
    const series = seriesRef.current;
    const d = latestQ.data;
    if (!series || !d) return;
    const v = pythSpot(d);
    const ms = obsMs(d);
    if (v == null || ms == null) return;
    const t = Math.floor(ms / 1000); // one point per second, same as the history
    if (t < lastTimeRef.current) return; // can't update an older point
    series.update({ time: t as UTCTimestamp, value: v });
    lastTimeRef.current = t;
  }, [latestQ.data]);

  // Draw the ticket's selection: binary = dashed strike line + win-zone shade;
  // range = the shaded band between the edges, marked with labeled "range start"
  // and "range end" lines — or, while only the first edge is picked, a single
  // dashed "range start" line so the trader sees the range land as they build it
  // (legacy parity). Tracks the store live.
  useEffect(() => {
    const series = seriesRef.current;
    const band = bandRef.current;
    const winZone = winZoneRef.current;
    if (!series || !band || !winZone) return;

    // Clear every selection line up front; redraw only the ones this state needs.
    for (const ref of [strikeLineRef, anchorLineRef, lowerLineRef, higherLineRef]) {
      if (ref.current) {
        series.removePriceLine(ref.current);
        ref.current = null;
      }
    }

    // Binary: dashed strike line + win-zone shade on the winning side.
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

    // Range: shaded band + labeled edges once both are set; a lone anchor line
    // while the band is still open.
    band.setBand(bandLow, bandHigh);
    if (bandLow != null && bandHigh != null) {
      lowerLineRef.current = series.createPriceLine({
        price: bandLow,
        color: BAND_LINE,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'range start',
      });
      higherLineRef.current = series.createPriceLine({
        price: bandHigh,
        color: BAND_LINE,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'range end',
      });
    } else if (anchor != null) {
      anchorLineRef.current = series.createPriceLine({
        price: anchor,
        color: BAND_LINE,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: 'range start',
      });
    }

    // Frame the active selection in the price scale (the autoscale provider reads
    // these refs): the binary strike, the full band, or the lone anchor line.
    strikeRangeRef.current = strike != null ? strike : bandLow == null ? anchor : null;
    bandRangeRef.current = bandLow != null && bandHigh != null ? { low: bandLow, high: bandHigh } : null;

    // Reframe so the selection is in view; runs only on selection changes, so
    // it doesn't fight the user's zoom mid-view.
    series.priceScale().setAutoScale(true);
  }, [strike, isUp, bandLow, bandHigh, anchor]);

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

"use client";

import { useEffect, useRef } from "react";
import {
  createChart,
  AreaSeries,
  LineStyle,
  ColorType,
  type IChartApi,
  type ISeriesApi,
  type IPriceLine,
  type ISeriesPrimitive,
  type IPrimitivePaneView,
  type IPrimitivePaneRenderer,
  type SeriesAttachedParameter,
  type AutoscaleInfo,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";

// The canvas target type (from fancy-canvas) isn't re-exported by the main
// entry — derive it from the renderer interface so the draw signature stays typed.
type RenderTarget = Parameters<IPrimitivePaneRenderer["draw"]>[0];
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { getPriceHistory, getLatestPrices, qk } from "@/lib/api/client";
import { useSurfaceStore } from "@/lib/store/surface-store";
import { useFrontOracleId } from "@/lib/hooks/use-front-oracle";
import { toFloat } from "@/config/scale";
import { price } from "@/lib/format";
import type { SmileInput } from "@/lib/svi/surface";
import type { Oracle, PriceEvent } from "@/lib/api/types";

const UP = "#4dd6b0";
const DOWN = "#f0796b";

/** PriceEvent[] (newest-first) → ascending, one point per second (keep latest). */
function toSeries(
  events: PriceEvent[],
): { time: UTCTimestamp; value: number }[] {
  const bySec = new Map<number, number>();
  for (const e of [...events].sort(
    (a, b) => a.onchain_timestamp - b.onchain_timestamp,
  )) {
    bySec.set(Math.floor(e.onchain_timestamp / 1000), toFloat(e.spot));
  }
  return [...bySec.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
}

const BAND_FILL = "rgba(77, 214, 176, 0.10)";
const BAND_LINE = "rgba(77, 214, 176, 0.55)";

/**
 * A shaded horizontal price band drawn full-width between two prices — used to
 * highlight the selected vertical range on the chart. Built as a lightweight-
 * charts series primitive so it stays pinned to the price scale while the user
 * scrolls/zooms and repaints live as the band changes (vs. a static DOM overlay
 * that would drift). Set `low`/`high` to draw; set them to null to hide.
 */
class PriceBandPrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<"Area"> | null = null;
  private _requestUpdate?: () => void;
  private _low: number | null = null;
  private _high: number | null = null;
  private readonly _view = new BandPaneView(this);

  attached(p: SeriesAttachedParameter<Time>) {
    this._series = p.series as ISeriesApi<"Area">;
    this._requestUpdate = p.requestUpdate;
  }
  detached() {
    this._series = null;
    this._requestUpdate = undefined;
  }
  updateAllViews() {
    this._view.update();
  }
  paneViews() {
    return [this._view];
  }

  setBand(low: number | null, high: number | null) {
    this._low = low;
    this._high = high;
    this._requestUpdate?.();
  }

  get series() {
    return this._series;
  }
  get low() {
    return this._low;
  }
  get high() {
    return this._high;
  }
}

class BandPaneView implements IPrimitivePaneView {
  private _yLow: number | null = null;
  private _yHigh: number | null = null;
  constructor(private readonly _source: PriceBandPrimitive) {}

  update() {
    const s = this._source.series;
    if (!s || this._source.low == null || this._source.high == null) {
      this._yLow = null;
      this._yHigh = null;
      return;
    }
    this._yLow = s.priceToCoordinate(this._source.low);
    this._yHigh = s.priceToCoordinate(this._source.high);
  }
  // Sit above the area fill so the highlight reads clearly; low alpha keeps the
  // price line legible through it.
  zOrder() {
    return "top" as const;
  }
  renderer(): IPrimitivePaneRenderer {
    return new BandPaneRenderer(this._yHigh, this._yLow);
  }
}

class BandPaneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _yTop: number | null, // high price → smaller y
    private readonly _yBot: number | null, // low price  → larger y
  ) {}

  draw(target: RenderTarget) {
    if (this._yTop == null || this._yBot == null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const vr = scope.verticalPixelRatio;
      const width = scope.bitmapSize.width;
      const yTop = Math.min(this._yTop!, this._yBot!) * vr;
      const yBot = Math.max(this._yTop!, this._yBot!) * vr;
      // translucent fill
      ctx.fillStyle = BAND_FILL;
      ctx.fillRect(0, yTop, width, yBot - yTop);
      // crisp boundary lines top + bottom
      const lw = Math.max(1, Math.round(vr));
      ctx.fillStyle = BAND_LINE;
      ctx.fillRect(0, yTop, width, lw);
      ctx.fillRect(0, yBot - lw, width, lw);
    });
  }
}

const ZONE_UP_FILL = "rgba(77, 214, 176, 0.10)";
const ZONE_DOWN_FILL = "rgba(240, 121, 107, 0.10)";

/**
 * Shades the WINNING side of a binary bet — everything above the strike (UP) or
 * below it (DOWN), full-width and tinted by direction — so a trader sees their
 * win-zone on the chart as they move the strike. A series primitive (pinned to
 * the price scale; repaints on scroll/zoom/strike change). `setZone(null, …)` hides.
 */
class WinZonePrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<"Area"> | null = null;
  private _requestUpdate?: () => void;
  private _strike: number | null = null;
  private _isUp = true;
  private readonly _view = new WinZonePaneView(this);

  attached(p: SeriesAttachedParameter<Time>) {
    this._series = p.series as ISeriesApi<"Area">;
    this._requestUpdate = p.requestUpdate;
  }
  detached() {
    this._series = null;
    this._requestUpdate = undefined;
  }
  updateAllViews() {
    this._view.update();
  }
  paneViews() {
    return [this._view];
  }

  setZone(strike: number | null, isUp: boolean) {
    this._strike = strike;
    this._isUp = isUp;
    this._requestUpdate?.();
  }
  get series() {
    return this._series;
  }
  get strike() {
    return this._strike;
  }
  get isUp() {
    return this._isUp;
  }
}

class WinZonePaneView implements IPrimitivePaneView {
  private _yStrike: number | null = null;
  constructor(private readonly _source: WinZonePrimitive) {}
  update() {
    const s = this._source.series;
    this._yStrike =
      s && this._source.strike != null ? s.priceToCoordinate(this._source.strike) : null;
  }
  zOrder() {
    return "top" as const;
  }
  renderer(): IPrimitivePaneRenderer {
    return new WinZoneRenderer(this._yStrike, this._source.isUp);
  }
}

class WinZoneRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _yStrike: number | null,
    private readonly _isUp: boolean,
  ) {}
  draw(target: RenderTarget) {
    if (this._yStrike == null) return;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const vr = scope.verticalPixelRatio;
      const w = scope.bitmapSize.width;
      const h = scope.bitmapSize.height;
      const y = this._yStrike! * vr;
      ctx.fillStyle = this._isUp ? ZONE_UP_FILL : ZONE_DOWN_FILL;
      if (this._isUp) ctx.fillRect(0, 0, w, y); // win zone is ABOVE the strike
      else ctx.fillRect(0, y, w, h - y); // …or BELOW it
    });
  }
}

export function PriceChart({
  oracles,
  initialInputs,
}: {
  oracles: Oracle[];
  initialInputs: SmileInput[];
}) {
  const selection = useSurfaceStore((s) => s.selection);
  const ticketMode = useSurfaceStore((s) => s.ticketMode);
  const rangeSelection = useSurfaceStore((s) => s.rangeSelection);
  const rangeAnchor = useSurfaceStore((s) => s.rangeAnchor);
  const frontId = useFrontOracleId(oracles[0]?.oracle_id ?? "");
  const activeId = selection?.oracleId ?? frontId;
  const activeOracle =
    oracles.find((o) => o.oracle_id === activeId) ?? oracles[0];
  const underlying = activeOracle?.underlying_asset ?? "BTC";

  // Seed the live tape from the SSR snapshot for the front oracle (no blank flash).
  const seed = initialInputs.find(
    (i) => i.oracle.oracle_id === activeId,
  )?.forward;

  const historyQ = useQuery({
    queryKey: ["price-history", activeId],
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
  const seriesRef = useRef<ISeriesApi<"Area"> | null>(null);
  const strikeLineRef = useRef<IPriceLine | null>(null);
  const bandRef = useRef<PriceBandPrimitive | null>(null);
  const anchorLineRef = useRef<IPriceLine | null>(null);
  // Current band range, read by the series' autoscaleInfoProvider so the price
  // scale always frames the selected range (with padding) — even when it's far
  // from spot. A ref so the provider closure sees the latest without re-creating.
  const bandRangeRef = useRef<{ low: number; high: number } | null>(null);
  // Selected BINARY strike — same idea as bandRangeRef, so the dashed strike line
  // is always framed even when the user picks a level away from spot.
  const strikeRangeRef = useRef<number | null>(null);
  const lastTimeRef = useRef<number>(0);
  const fittedRef = useRef(false);

  // Create the chart once. autoSize handles resize via an internal ResizeObserver.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8b9099",
        fontFamily: "var(--font-geist-mono), monospace",
        fontSize: 10,
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: "rgba(255,255,255,0.035)" },
        horzLines: { color: "rgba(255,255,255,0.035)" },
      },
      rightPriceScale: { borderColor: "rgba(255,255,255,0.08)" },
      timeScale: {
        borderColor: "rgba(255,255,255,0.08)",
        timeVisible: true,
        secondsVisible: false,
        // Keep a few seconds of breathing room to the right of the latest point so
        // the live edge never sits flush against the price axis (the "cut off at
        // the end" look). rightOffset is preserved as new ticks arrive, which also
        // keeps the chart tracking the most recent point.
        rightOffset: 6,
      },
      crosshair: {
        vertLine: {
          color: "rgba(255,255,255,0.18)",
          labelBackgroundColor: "#181c20",
        },
        horzLine: {
          color: "rgba(255,255,255,0.18)",
          labelBackgroundColor: "#181c20",
        },
      },
    });
    const series = chart.addSeries(AreaSeries, {
      lineColor: UP,
      topColor: "rgba(77,214,176,0.22)",
      bottomColor: "rgba(77,214,176,0)",
      lineWidth: 2,
      priceLineVisible: false,
      priceFormat: { type: "price", precision: 0, minMove: 1 },
      // Extend the auto-scale to include the selected range so the band is always
      // framed (with padding) — even if the entry is far from current spot.
      autoscaleInfoProvider: (baseImpl: () => AutoscaleInfo | null): AutoscaleInfo | null => {
        const base = baseImpl();
        const band = bandRangeRef.current;
        const strike = strikeRangeRef.current;
        let lo: number | null = null;
        let hi: number | null = null;
        if (band) {
          // Pad proportional to the band's own height so the scale frames the
          // range tightly (floor of 1 guards a degenerate zero-width band).
          const pad = Math.max((band.high - band.low) * 0.25, 1);
          lo = band.low - pad;
          hi = band.high + pad;
        }
        if (strike != null) {
          // Pad around a single strike line off the visible price span so it's
          // never flush to an edge (and the spot history still frames the rest).
          const span = base?.priceRange ? base.priceRange.maxValue - base.priceRange.minValue : strike * 0.01;
          const pad = Math.max(span * 0.08, 1);
          lo = lo == null ? strike - pad : Math.min(lo, strike - pad);
          hi = hi == null ? strike + pad : Math.max(hi, strike + pad);
        }
        if (lo == null || hi == null) return base;
        if (!base?.priceRange) {
          return { priceRange: { minValue: lo, maxValue: hi } };
        }
        return {
          ...base,
          priceRange: {
            minValue: Math.min(base.priceRange.minValue, lo),
            maxValue: Math.max(base.priceRange.maxValue, hi),
          },
        };
      },
    });
    // Range-band highlight, attached once and driven by the range effect below.
    const band = new PriceBandPrimitive();
    series.attachPrimitive(band);

    chartRef.current = chart;
    seriesRef.current = series;
    bandRef.current = band;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      strikeLineRef.current = null;
      anchorLineRef.current = null;
      bandRef.current = null;
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
      // fitContent pins the last bar flush against the right axis; snap to the
      // live edge so the latest point shows with the rightOffset gap from the start.
      chartRef.current?.timeScale().scrollToRealTime();
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

  // Draw the selected strike as a dashed price line — binary mode only (range
  // mode shows the band instead, below).
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (strikeLineRef.current) {
      series.removePriceLine(strikeLineRef.current);
      strikeLineRef.current = null;
    }
    if (ticketMode !== "range" && selection && selection.oracleId === activeId) {
      strikeLineRef.current = series.createPriceLine({
        price: selection.strike,
        color: selection.isUp ? UP : DOWN,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: `strike ${selection.isUp ? "▲" : "▼"}`,
      });
      // Keep the strike line framed (autoscale provider reads this ref).
      strikeRangeRef.current = selection.strike;
    } else {
      strikeRangeRef.current = null;
    }
    series.priceScale().setAutoScale(true);
  }, [selection, activeId, ticketMode]);

  // Highlight the selected vertical range — a shaded band (lower→higher) in range
  // mode, tracking the ticket live. While only the first bound is picked, show a
  // dashed anchor line so the user sees the pick land on the chart immediately.
  useEffect(() => {
    const series = seriesRef.current;
    const band = bandRef.current;
    if (!series || !band) return;

    if (anchorLineRef.current) {
      series.removePriceLine(anchorLineRef.current);
      anchorLineRef.current = null;
    }

    const inRange = ticketMode === "range";
    const bandForActive =
      inRange && rangeSelection && rangeSelection.oracleId === activeId
        ? rangeSelection
        : null;

    band.setBand(bandForActive?.lower ?? null, bandForActive?.higher ?? null);

    // Reframe the price scale so the band (or, when cleared, just the data) is in
    // view. This effect only runs on selection changes, so re-enabling autoscale
    // here reframes on each new pick without fighting the user's zoom mid-view.
    bandRangeRef.current = bandForActive
      ? { low: bandForActive.lower, high: bandForActive.higher }
      : null;
    series.priceScale().setAutoScale(true);

    if (
      inRange &&
      !bandForActive &&
      rangeAnchor &&
      rangeAnchor.oracleId === activeId
    ) {
      anchorLineRef.current = series.createPriceLine({
        price: rangeAnchor.strike,
        color: BAND_LINE,
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: "range start",
      });
    }
  }, [ticketMode, rangeSelection, rangeAnchor, activeId]);

  const spot = latestQ.data ? toFloat(latestQ.data.spot) : (seed ?? null);

  return (
    <div className="relative h-full w-full bg-bg-0">
      {/* Header — underlying + live spot, mirroring the surface's top-right label */}
      <div className="pointer-events-none absolute right-4 top-3 z-10 flex items-center gap-2">
        <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">
          {underlying}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">
          spot
        </span>
        <span className="font-mono text-[13px] tabular-nums text-text-1">
          {spot == null ? "—" : price(spot)}
        </span>
      </div>

      {!activeId || (historyQ.isError && !historyQ.data) ? (
        <div className="flex h-full items-center justify-center text-[12px] text-text-3">
          {historyQ.isError
            ? "Could not load price history."
            : "No live market to chart."}
        </div>
      ) : (
        <div ref={containerRef} className="h-full w-full" />
      )}
    </div>
  );
}

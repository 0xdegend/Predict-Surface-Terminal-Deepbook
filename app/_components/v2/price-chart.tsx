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
import { useCallback, useEffect, useRef } from 'react';
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
  type AreaData,
  type WhitespaceData,
} from 'lightweight-charts';
import { useQuery } from '@tanstack/react-query';
import { PriceBandPrimitive, WinZonePrimitive, LivePulsePrimitive, BAND_LINE } from '@/app/_components/chart/price-overlays';
import { StaleFeedOverlay } from './stale-feed-overlay';
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
 * A feed gap longer than this (seconds) BREAKS the line instead of drawing a
 * straight segment across the missing time. The feed publishes ~1/sec, so a
 * multi-second hole is a real stall (a keeper hiccup) — bridging it would paint
 * price action that never happened: a fake flat plateau when the gap is quiet, a
 * fake vertical cliff when price moved during it. An honest break reads as "no
 * data here" and the line resumes when the feed does. 5s clears normal 1-3s
 * jitter so a healthy feed never fragments.
 */
const GAP_BREAK_S = 5;

// Live-edge motion engine tuning. Between the ~1.5s Pyth polls the last point
// GLIDES toward the freshest tick instead of snapping, so the line breathes and
// the pulse dot rides it smoothly.
const LERP = 0.18; // fraction of the remaining gap closed per animation frame
const SETTLE_USD = 0.5; // snap to target once within this (ends the glide)
const WRITE_EPS_USD = 0.02; // skip a series write smaller than this (no-op churn)
const PULSE_MS = 33; // idle repaint cadence (~30fps) that keeps the ring pulsing

// Momentum tint: colour the line, fill, and pulse dot by recent direction. Compare
// the live value to ~LOOKBACK seconds ago; a small deadband (never flips inside it)
// keeps the tint from flickering when price is basically flat.
const MOMENTUM_LOOKBACK_S = 45;
const MOMENTUM_KEEP_S = 130; // rolling sample window kept for the lookup
const UP_TOP = 'rgba(77, 214, 176, 0.22)';
const UP_BOT = 'rgba(77, 214, 176, 0)';
const DOWN_TOP = 'rgba(240, 121, 107, 0.22)';
const DOWN_BOT = 'rgba(240, 121, 107, 0)';

type ChartPoint = AreaData<UTCTimestamp> | WhitespaceData<UTCTimestamp>;

/**
 * Observations → ascending points, ONE per second (last value in the second
 * wins). Per-second decimation rejects the feed's sub-second noise — bid/ask
 * flip, multi-publisher jitter, momentary outliers — which otherwise renders as a
 * jagged zig-zag AND makes the price scale constantly re-expand and snap back. BTC
 * moves only a few dollars per second, so the resulting ~1/sec line is smooth and
 * honest. Real feed gaps get a whitespace break (see GAP_BREAK_S).
 */
function toSeries(obs: PythObservation[]): ChartPoint[] {
  const bySec = new Map<number, number>();
  // Sort by full ms so, within a second, the chronologically LAST tick wins.
  for (const o of [...obs].sort((a, b) => (obsMs(a) ?? 0) - (obsMs(b) ?? 0))) {
    const v = pythSpot(o);
    const ms = obsMs(o);
    if (v == null || ms == null) continue;
    bySec.set(Math.floor(ms / 1000), v);
  }
  const entries = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
  const out: ChartPoint[] = [];
  let prevSec: number | null = null;
  for (const [time, value] of entries) {
    // Break the line across a real gap: a whitespace point (time, no value) right
    // after the last real point severs the segment so nothing is drawn across the
    // hole. The series still ends on a value point (whitespace only precedes one).
    if (prevSec != null && time - prevSec > GAP_BREAK_S) {
      out.push({ time: (prevSec + 1) as UTCTimestamp });
    }
    out.push({ time: time as UTCTimestamp, value });
    prevSec = time;
  }
  return out;
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
  // Live-edge engine (see renderLive): the pulse dot + the smooth glide of the
  // leading point. `target` = freshest per-second tick; `disp` = what's actually
  // drawn (chases target). `written*` dedupe redundant series writes; `lastPulse`
  // throttles idle ring repaints; `raf`/`animate` drive the rAF loop.
  const pulseRef = useRef<LivePulsePrimitive | null>(null);
  const targetRef = useRef<{ time: number; value: number } | null>(null);
  const dispRef = useRef<{ time: number; value: number } | null>(null);
  const writtenTimeRef = useRef(0);
  const writtenValRef = useRef(0);
  const lastPulseRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const animateRef = useRef(true);
  // Momentum tint state: a rolling (time, value) buffer for the lookback, the
  // current direction, and the last one actually painted (so we only re-apply the
  // line/fill colours on a real flip, not every tick).
  const samplesRef = useRef<{ t: number; v: number }[]>([]);
  const momentumRef = useRef<'up' | 'down'>('up');
  const appliedMomentumRef = useRef<'up' | 'down' | null>(null);
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

  // 500 per-second points requested; the on-chain reader's page budget caps it at a
  // legacy-length ~3 min window (the 8-06 feed runs ~5 obs/sec, so it's the budget,
  // not this number, that governs — see onchainPythObservations). This is BACKFILL:
  // the live edge is driven by latestQ (~1.5s) and appended by the rAF engine, so the
  // history only needs to heal/re-anchor occasionally — 60s keeps the ~18-page walk
  // off the hot path without ever staling the visible line.
  const historyQ = useQuery({ queryKey: qkV2.pythHistory, queryFn: () => getPythHistory(PID, 500), refetchInterval: 60_000 });
  const latestQ = useQuery({ queryKey: qkV2.pythLatest, queryFn: () => getPythLatest(PID), refetchInterval: 1500 });

  // Paint the current momentum onto the line, area fill, and pulse dot — but only
  // when it actually flipped, so a steady trend doesn't re-apply options every tick.
  const applyMomentum = useCallback(() => {
    const dir = momentumRef.current;
    if (appliedMomentumRef.current === dir) return;
    appliedMomentumRef.current = dir;
    const up = dir === 'up';
    seriesRef.current?.applyOptions({
      lineColor: up ? UP : DOWN,
      topColor: up ? UP_TOP : DOWN_TOP,
      bottomColor: up ? UP_BOT : DOWN_BOT,
    });
    pulseRef.current?.setMomentum(dir);
  }, []);

  // Recompute direction from the buffer: latest vs the sample ~LOOKBACK ago. Inside
  // the deadband we KEEP the previous direction (hysteresis), so flat tape doesn't
  // strobe the tint.
  const recomputeMomentum = useCallback(() => {
    const buf = samplesRef.current;
    if (buf.length >= 2) {
      const latest = buf[buf.length - 1];
      const refTime = latest.t - MOMENTUM_LOOKBACK_S;
      let ref = buf[0];
      for (let i = buf.length - 1; i >= 0; i--) {
        if (buf[i].t <= refTime) {
          ref = buf[i];
          break;
        }
      }
      const delta = latest.v - ref.v;
      const dead = Math.max(3, ref.v * 0.00005); // ~0.005%, floored at $3
      if (delta > dead) momentumRef.current = 'up';
      else if (delta < -dead) momentumRef.current = 'down';
    }
    applyMomentum();
  }, [applyMomentum]);

  // Record a sample (dedupe per second, keep it time-ordered, prune old) then
  // re-evaluate the tint.
  const ingestMomentum = useCallback(
    (t: number, v: number) => {
      const buf = samplesRef.current;
      if (buf.length && buf[buf.length - 1].t === t) buf[buf.length - 1].v = v;
      else if (!buf.length || t > buf[buf.length - 1].t) buf.push({ t, v });
      else return; // out of order — ignore
      const cutoff = t - MOMENTUM_KEEP_S;
      while (buf.length > 1 && buf[0].t < cutoff) buf.shift();
      recomputeMomentum();
    },
    [recomputeMomentum],
  );

  // One step of the live-edge engine: chase `target` (freshest tick) with `disp`
  // (the drawn leading point) and keep the pulse dot on it. Called every animation
  // frame while motion is on, or once per tick when it's off (reduced-motion). All
  // state lives in refs so this closure is stable and never re-subscribes effects.
  const renderLive = useCallback(() => {
    const series = seriesRef.current;
    const pulse = pulseRef.current;
    const tgt = targetRef.current;
    if (!series || !tgt) return;
    const animate = animateRef.current;
    let disp = dispRef.current;

    if (!disp) {
      // First point: place it exactly.
      disp = { time: tgt.time, value: tgt.value };
    } else if (tgt.time > disp.time) {
      // A new second arrived. Bridge a real stall with an honest break; otherwise
      // open the new second seeded at the current drawn value so it glides up to
      // the tick (snap straight to it when motion is off).
      if (tgt.time - disp.time > GAP_BREAK_S) {
        series.update({ time: (disp.time + 1) as UTCTimestamp });
        disp = { time: tgt.time, value: tgt.value };
      } else {
        disp = { time: tgt.time, value: animate ? disp.value : tgt.value };
      }
    } else {
      // Same second: ease the value toward the tick (or snap when motion is off).
      const next = animate ? disp.value + (tgt.value - disp.value) * LERP : tgt.value;
      disp = { time: disp.time, value: Math.abs(tgt.value - next) < SETTLE_USD ? tgt.value : next };
    }
    dispRef.current = disp;

    // Write the leading point only when it actually moved (advanced a second or
    // shifted more than the epsilon) — avoids 60fps no-op churn once it settles.
    let wrote = false;
    if (disp.time !== writtenTimeRef.current || Math.abs(disp.value - writtenValRef.current) >= WRITE_EPS_USD) {
      series.update({ time: disp.time as UTCTimestamp, value: disp.value });
      writtenTimeRef.current = disp.time;
      writtenValRef.current = disp.value;
      wrote = true;
    }

    // Keep the pulse on the leading point. A series write already repainted, so
    // reposition it then; when idle, still repaint at ~30fps so the ring animates.
    if (pulse) {
      const now = performance.now();
      if (wrote) {
        pulse.setPoint(disp.time as UTCTimestamp, disp.value);
        lastPulseRef.current = now;
      } else if (animate && now - lastPulseRef.current >= PULSE_MS) {
        pulse.setPoint(disp.time as UTCTimestamp, disp.value);
        lastPulseRef.current = now;
      }
    }
  }, []);

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
      //
      // lockVisibleTimeRangeOnResize keeps the SAME time span filling the width when
      // the container resizes (toggling Surface↔Chart, a panel/window resize, or the
      // first layout settle): widening stretches the bars instead of leaving empty
      // space on the left. fixLeftEdge is the belt-and-suspenders clamp — the view
      // can never scroll or settle past the first data point into that left gap.
      // rightOffset keeps the live-edge breathing room on the right.
      timeScale: {
        borderColor: 'rgba(255,255,255,0.08)',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 6,
        lockVisibleTimeRangeOnResize: true,
        fixLeftEdge: true,
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
    // The live-edge pulse dot rides on top of everything.
    const pulse = new LivePulsePrimitive();
    series.attachPrimitive(pulse);

    chartRef.current = chart;
    seriesRef.current = series;
    bandRef.current = band;
    winZoneRef.current = winZone;
    pulseRef.current = pulse;
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
      pulseRef.current = null;
    };
  }, []);

  // Seed / backfill history.
  useEffect(() => {
    const series = seriesRef.current;
    if (!series || !historyQ.data) return;
    const points = toSeries(historyQ.data);
    if (!points.length) return;
    series.setData(points);
    // Resync the live engine to the fresh history tail. Keep any newer live point
    // ahead of it (a 30s refetch trails the ~1.5s live edge), so the glide/dot
    // don't jump backward; otherwise seed both from the tail.
    const last = points[points.length - 1];
    const tail = 'value' in last ? { time: last.time as number, value: last.value } : null;
    if (tail) {
      if (!targetRef.current || targetRef.current.time <= tail.time) {
        targetRef.current = { ...tail };
        dispRef.current = { ...tail };
      }
      writtenTimeRef.current = tail.time;
      writtenValRef.current = 'value' in last ? last.value : 0;
      renderLive(); // re-place the (possibly newer) live point on top of history
    }
    // Seed the momentum buffer from the fresh history so the tint is right on load
    // (and stays correct after each 30s refetch); live ticks append onto it.
    samplesRef.current = points
      .filter((p): p is AreaData<UTCTimestamp> => 'value' in p)
      .map((p) => ({ t: p.time as number, v: p.value }));
    recomputeMomentum();
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
  }, [historyQ.data, renderLive, recomputeMomentum]);

  // Ingest the live tick: set the engine's TARGET (the freshest per-second value);
  // the rAF loop glides the drawn edge toward it. When motion is off (reduced-
  // motion), there's no loop, so render the snap right here. The per-second bucket
  // + single clock match the history, so an intra-second tick refines the current
  // second and each new second advances the edge (legacy parity).
  useEffect(() => {
    const d = latestQ.data;
    if (!d) return;
    const v = pythSpot(d);
    const ms = obsMs(d);
    if (v == null || ms == null) return;
    const t = Math.floor(ms / 1000);
    if (targetRef.current && t < targetRef.current.time) return; // never go backward
    targetRef.current = { time: t, value: v };
    ingestMomentum(t, v);
    if (!animateRef.current) renderLive();
  }, [latestQ.data, renderLive, ingestMomentum]);

  // The animation loop that powers the glide + pulse. Runs only when motion is
  // allowed AND the tab is visible: reduced-motion users get a static dot and
  // snapped ticks (handled in the tick effect), and a hidden tab burns no frames.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    const start = () => {
      if (rafRef.current != null) return;
      const frame = () => {
        renderLive();
        rafRef.current = requestAnimationFrame(frame);
      };
      rafRef.current = requestAnimationFrame(frame);
    };
    const stop = () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
    const apply = () => {
      const motion = !mq.matches;
      animateRef.current = motion;
      pulseRef.current?.setAnimate(motion);
      if (motion && !document.hidden) start();
      else {
        stop();
        renderLive(); // keep the edge current even without the loop
      }
    };
    apply();
    mq.addEventListener('change', apply);
    document.addEventListener('visibilitychange', apply);
    return () => {
      stop();
      mq.removeEventListener('change', apply);
      document.removeEventListener('visibilitychange', apply);
    };
  }, [renderLive]);

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
      {/* When the upstream spot feed freezes, blur the (frozen) chart + say so. */}
      <StaleFeedOverlay />
    </div>
  );
}

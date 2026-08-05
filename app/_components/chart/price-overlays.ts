/**
 * Shared lightweight-charts overlay primitives for the price charts (legacy +
 * v2): a horizontal range-band highlight and a binary win-zone shade. Both are
 * series primitives so they stay pinned to the price scale while the user
 * scrolls/zooms and repaint live as the selection changes (vs. a static DOM
 * overlay that would drift). Deployment-agnostic — they only speak prices.
 */
import type {
  IChartApi,
  ISeriesApi,
  ISeriesPrimitive,
  IPrimitivePaneView,
  IPrimitivePaneRenderer,
  SeriesAttachedParameter,
  Time,
} from 'lightweight-charts';

// The canvas target type (from fancy-canvas) isn't re-exported by the main
// entry — derive it from the renderer interface so the draw signature stays typed.
type RenderTarget = Parameters<IPrimitivePaneRenderer['draw']>[0];

export const BAND_FILL = 'rgba(77, 214, 176, 0.10)';
export const BAND_LINE = 'rgba(77, 214, 176, 0.55)';

/**
 * A shaded horizontal price band drawn full-width between two prices — used to
 * highlight the selected vertical range on the chart. Set `low`/`high` to draw;
 * set them to null to hide.
 */
export class PriceBandPrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<'Area'> | null = null;
  private _requestUpdate?: () => void;
  private _low: number | null = null;
  private _high: number | null = null;
  private readonly _view = new BandPaneView(this);

  attached(p: SeriesAttachedParameter<Time>) {
    this._series = p.series as ISeriesApi<'Area'>;
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
    return 'top' as const;
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

const ZONE_UP_FILL = 'rgba(77, 214, 176, 0.10)';
const ZONE_DOWN_FILL = 'rgba(240, 121, 107, 0.10)';

/**
 * Shades the WINNING side of a binary bet — everything above the strike (UP) or
 * below it (DOWN), full-width and tinted by direction — so a trader sees their
 * win-zone on the chart as they move the strike. `setZone(null, …)` hides.
 */
export class WinZonePrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<'Area'> | null = null;
  private _requestUpdate?: () => void;
  private _strike: number | null = null;
  private _isUp = true;
  private readonly _view = new WinZonePaneView(this);

  attached(p: SeriesAttachedParameter<Time>) {
    this._series = p.series as ISeriesApi<'Area'>;
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
    return 'top' as const;
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

// The live-edge marker's two momentum colours (up = teal, down = coral), each as
// an "r,g,b" triple so the glow/ring can vary only the alpha, plus a solid hex for
// the core. Matches the up/down semantic colours used across the terminal.
const PULSE_UP_RGB = '77, 214, 176';
const PULSE_UP_CORE = '#4dd6b0';
const PULSE_DOWN_RGB = '240, 121, 107';
const PULSE_DOWN_CORE = '#f0796b';

type PulseDir = 'up' | 'down';

/**
 * A glowing, softly pulsing dot pinned to the chart's live edge — the "you are
 * here, and it's live" marker. Positioned at an arbitrary (time, value), so the
 * chart can glide it smoothly between ticks (see the price chart's lerp engine)
 * and it always sits exactly on the line's leading point.
 *
 * Unlike the band/win-zone (which pin to the price scale only), this reads the
 * time scale too — its x comes from `chart.timeScale().timeToCoordinate(time)` —
 * so it tracks horizontally as the live edge advances and as the user scrolls.
 * The expanding ring is time-based (`Date.now()`), so it animates as long as
 * something requests repaints; `setAnimate(false)` freezes it to a static dot for
 * reduced-motion. `setPoint(null, null)` hides it.
 */
export class LivePulsePrimitive implements ISeriesPrimitive<Time> {
  private _series: ISeriesApi<'Area'> | null = null;
  private _chart: IChartApi | null = null;
  private _requestUpdate?: () => void;
  private _time: Time | null = null;
  private _value: number | null = null;
  private _animate = true;
  private _momentum: PulseDir = 'up';
  private readonly _view = new LivePulsePaneView(this);

  attached(p: SeriesAttachedParameter<Time>) {
    this._series = p.series as ISeriesApi<'Area'>;
    this._chart = p.chart;
    this._requestUpdate = p.requestUpdate;
  }
  detached() {
    this._series = null;
    this._chart = null;
    this._requestUpdate = undefined;
  }
  updateAllViews() {
    this._view.update();
  }
  paneViews() {
    return [this._view];
  }

  /** Move the dot to (time, value); pass nulls to hide. Requests a repaint — which
   *  is also what advances the pulse animation each frame. */
  setPoint(time: Time | null, value: number | null) {
    this._time = time;
    this._value = value;
    this._requestUpdate?.();
  }
  setAnimate(on: boolean) {
    this._animate = on;
    this._requestUpdate?.();
  }
  /** Tint the dot by recent price direction (up = teal, down = coral). */
  setMomentum(dir: PulseDir) {
    this._momentum = dir;
    this._requestUpdate?.();
  }

  get series() {
    return this._series;
  }
  get chart() {
    return this._chart;
  }
  get time() {
    return this._time;
  }
  get value() {
    return this._value;
  }
  get animate() {
    return this._animate;
  }
  get momentum() {
    return this._momentum;
  }
}

class LivePulsePaneView implements IPrimitivePaneView {
  private _x: number | null = null;
  private _y: number | null = null;
  constructor(private readonly _source: LivePulsePrimitive) {}
  update() {
    const s = this._source.series;
    const c = this._source.chart;
    if (!s || !c || this._source.time == null || this._source.value == null) {
      this._x = null;
      this._y = null;
      return;
    }
    this._x = c.timeScale().timeToCoordinate(this._source.time);
    this._y = s.priceToCoordinate(this._source.value);
  }
  zOrder() {
    return 'top' as const;
  }
  renderer(): IPrimitivePaneRenderer {
    return new LivePulseRenderer(this._x, this._y, this._source.animate, this._source.momentum);
  }
}

class LivePulseRenderer implements IPrimitivePaneRenderer {
  constructor(
    private readonly _x: number | null,
    private readonly _y: number | null,
    private readonly _animate: boolean,
    private readonly _momentum: PulseDir,
  ) {}
  draw(target: RenderTarget) {
    if (this._x == null || this._y == null) return;
    const rgb = this._momentum === 'down' ? PULSE_DOWN_RGB : PULSE_UP_RGB;
    const core = this._momentum === 'down' ? PULSE_DOWN_CORE : PULSE_UP_CORE;
    target.useBitmapCoordinateSpace((scope) => {
      const ctx = scope.context;
      const ratio = scope.horizontalPixelRatio;
      const cx = this._x! * scope.horizontalPixelRatio;
      const cy = this._y! * scope.verticalPixelRatio;
      const r = (px: number) => px * ratio; // media px → bitmap px (uniform)
      ctx.save();
      // Expanding, fading pulse ring — one cycle every PERIOD ms, radius growing
      // outward from the core while its alpha falls to zero.
      if (this._animate) {
        const PERIOD = 1700;
        const t = (Date.now() % PERIOD) / PERIOD; // 0 → 1
        ctx.beginPath();
        ctx.arc(cx, cy, r(4) + t * r(11), 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${rgb}, ${(1 - t) * 0.4})`;
        ctx.lineWidth = Math.max(1, r(1));
        ctx.stroke();
      }
      // Soft radial glow under the core.
      const glowR = r(9);
      const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, glowR);
      glow.addColorStop(0, `rgba(${rgb}, 0.45)`);
      glow.addColorStop(1, `rgba(${rgb}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(cx, cy, glowR, 0, Math.PI * 2);
      ctx.fill();
      // Solid core + a bright centre so it reads as a live indicator, not a plot dot.
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(cx, cy, r(3), 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
      ctx.beginPath();
      ctx.arc(cx, cy, r(1.1), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    });
  }
}

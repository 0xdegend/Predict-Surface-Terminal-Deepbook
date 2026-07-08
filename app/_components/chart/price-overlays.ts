/**
 * Shared lightweight-charts overlay primitives for the price charts (legacy +
 * v2): a horizontal range-band highlight and a binary win-zone shade. Both are
 * series primitives so they stay pinned to the price scale while the user
 * scrolls/zooms and repaint live as the selection changes (vs. a static DOM
 * overlay that would drift). Deployment-agnostic — they only speak prices.
 */
import type {
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

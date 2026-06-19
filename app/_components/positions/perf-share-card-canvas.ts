/**
 * perf-share-card-canvas.ts — paints a trader's SETTLED TRACK RECORD as a
 * shareable promotional card (the Performance bento, as an image). Companion to
 * share-card-canvas.ts (which shares a single position); both reuse the same
 * chrome primitives so a shared card always reads as the same product.
 *
 * Two styles:
 *   • record   — win-rate hero + a cumulative-PnL curve + a stat strip (default)
 *   • spotlight — one big centered WIN RATE %, the record + PnL beneath
 *
 * 1200×675 (16:9) at 2× → 2400×1350 PNG.
 */
import { signed, pct } from '@/lib/format';
import {
  SHARE_DIMS,
  tokens,
  fontFamily,
  withAlpha,
  fitSize,
  drawTag,
  roundRect,
  spaced,
  getShareLogo,
  type Theme,
} from './share-card-canvas';

const { W, H, P } = SHARE_DIMS;

export interface PerfShareData {
  winRate: number; // 0..1
  wins: number;
  losses: number;
  settled: number;
  realizedPnl: number; // DUSDC, signed
  staked: number; // DUSDC
  avgRoi: number; // ratio (realizedPnl / staked)
  best: number; // best single-trade PnL (DUSDC, signed)
  streak: { count: number; won: boolean } | null;
  /** Chronological cumulative realized-PnL values (oldest→newest) for the curve. */
  curve: number[];
}

export type PerfShareVariant = 'record' | 'spotlight';

export const PERF_SHARE_VARIANTS: { id: PerfShareVariant; label: string }[] = [
  { id: 'record', label: 'Record' },
  { id: 'spotlight', label: 'Spotlight' },
];

/** Spell out wins ("4 wins" / "1 win"); losses stay compact ("4L"). Matches the
 *  in-app Performance card. */
function winsLabel(n: number): string {
  return `${n} ${n === 1 ? 'win' : 'wins'}`;
}

function recordLine(d: PerfShareData): string {
  return `${winsLabel(d.wins)} · ${d.losses}L · ${d.settled} settled`;
}

interface Ctx {
  ctx: CanvasRenderingContext2D;
  c: Theme;
  sans: string;
  mono: string;
  accent: string;
  d: PerfShareData;
}

/**
 * Paint a performance card onto `canvas`. `scale` 2 = retina, <1 = thumbnail; all
 * drawing math stays in logical 1200×675 space. Fonts + logo must be ready first
 * (`await Promise.all([document.fonts.ready, loadShareLogo()])` upstream).
 */
export function drawPerfShareCard(
  canvas: HTMLCanvasElement,
  d: PerfShareData,
  opts: { variant?: PerfShareVariant; scale?: number } = {},
) {
  const variant = opts.variant ?? 'record';
  const scale = opts.scale ?? 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.resetTransform?.();
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';

  const c = tokens();
  // One semantic color: teal for a winning record, coral otherwise.
  const accent = d.winRate >= 0.5 ? c.up : c.down;
  const s: Ctx = { ctx, c, sans: fontFamily('sans'), mono: fontFamily('mono'), accent, d };

  drawBackground(s, variant);
  if (variant === 'spotlight') drawSpotlight(s);
  else drawRecord(s);
  drawHeader(s);
  drawFooter(s);
}

/* ===================== shared chrome ===================== */

function drawBackground({ ctx, c, accent }: Ctx, variant: PerfShareVariant) {
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  const gx = variant === 'spotlight' ? W / 2 : W - 120;
  const gy = variant === 'spotlight' ? H / 2 : 120;
  const r = variant === 'spotlight' ? 520 : 620;
  const glow = ctx.createRadialGradient(gx, gy, 30, gx, gy, r);
  glow.addColorStop(0, withAlpha(accent, variant === 'spotlight' ? 0.2 : 0.16));
  glow.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(60, H - 40, 20, 60, H - 40, 460);
  glow2.addColorStop(0, withAlpha(accent, 0.07));
  glow2.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Faint dot-grid texture.
  ctx.fillStyle = 'rgba(255,255,255,0.022)';
  for (let y = 40; y < H; y += 30) {
    for (let x = 40; x < W; x += 30) {
      ctx.beginPath();
      ctx.arc(x, y, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Accent hairline along the very top.
  const rail = ctx.createLinearGradient(0, 0, W, 0);
  rail.addColorStop(0, withAlpha(accent, 0));
  rail.addColorStop(0.5, withAlpha(accent, 0.8));
  rail.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = rail;
  ctx.fillRect(0, 0, W, 3);
}

function drawHeader({ ctx, c, accent, sans }: Ctx) {
  const brandY = 78;
  const markSize = 30;
  const logo = getShareLogo();
  if (logo) {
    ctx.drawImage(logo, P, brandY - 24, markSize, markSize);
  } else {
    ctx.beginPath();
    ctx.arc(P + 8, brandY - 6, 6, 0, Math.PI * 2);
    ctx.fillStyle = c.up;
    ctx.fill();
  }

  const textX = P + markSize + 12;
  ctx.textAlign = 'left';
  ctx.font = `600 30px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText('Skew', textX, brandY + 4);
  const brandW = ctx.measureText('Skew').width;
  drawTag(ctx, 'DEEPBOOK · SUI', textX + brandW + 14, brandY - 19, c.text3, c.line, sans);

  // Right pill: "TRACK RECORD".
  drawPill(ctx, 'TRACK RECORD', W - P, brandY - 18, accent, sans);
}

function drawFooter({ ctx, c, sans }: Ctx) {
  ctx.textAlign = 'left';
  const y = H - 30;
  // The live site — prominent (brand teal) so every shared card points home.
  ctx.font = `600 15px ${sans}`;
  ctx.fillStyle = c.up;
  ctx.fillText('tryskew.xyz', P, y);
  const urlW = ctx.measureText('tryskew.xyz').width;
  // Context, secondary.
  ctx.font = `400 14px ${sans}`;
  ctx.fillStyle = c.text2;
  ctx.fillText('   ·   the live volatility surface · DeepBook Predict on Sui', P + urlW, y);

  ctx.font = `600 11px ${sans}`;
  const tnW = ctx.measureText(spaced('TESTNET')).width;
  drawTag(ctx, 'TESTNET', W - P - tnW - 22, H - 46, c.warn, withAlpha(c.warn, 0.3), sans);
}

/* ===================== variant: record ===================== */

function drawRecord(s: Ctx) {
  const { ctx, c, accent, sans, mono, d } = s;

  ctx.textAlign = 'left';
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('WIN RATE'), P, 188);

  // Hero win-rate % — kept clear of the curve on the right.
  const heroText = pct(d.winRate, 1);
  const heroPx = fitSize(ctx, heroText, 460, 150, 700, mono);
  const heroBaseline = 192 + heroPx * 0.8;
  ctx.font = `700 ${heroPx}px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(heroText, P, heroBaseline);

  // Record line under the hero.
  ctx.font = `500 22px ${mono}`;
  ctx.fillStyle = c.text2;
  ctx.fillText(recordLine(d), P, heroBaseline + 46);

  // Cumulative-PnL curve on the right (replaces the old W/L meter) — tells the
  // story of how the track record was built, trade by trade.
  drawEquityChart(s, 612, 168, W - P - 612, 300);

  drawStatStrip(s);
}

/** The cumulative-PnL curve: a small labelled equity chart (area + line + a
 *  dashed zero baseline), colored teal/coral by the final tally. */
function drawEquityChart(s: Ctx, x: number, y: number, w: number, h: number) {
  const { ctx, c, accent, sans, mono, d } = s;

  ctx.textAlign = 'left';
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('CUMULATIVE PNL'), x, y);

  const finalPnl = d.curve.length ? d.curve[d.curve.length - 1] : d.realizedPnl;
  ctx.font = `600 20px ${mono}`;
  ctx.fillStyle = finalPnl >= 0 ? c.up : c.down;
  ctx.fillText(`${signed(finalPnl)} DUSDC`, x, y + 28);

  const plotY = y + 46;
  const plotH = y + h - plotY;
  // Prepend the zero baseline so the curve visibly rises/falls from flat.
  drawCurve(ctx, [0, ...d.curve], x, plotY, w, plotH, accent, c);
}

/** Area + line + dashed zero reference, in logical card space. */
function drawCurve(
  ctx: CanvasRenderingContext2D,
  data: number[],
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: string,
  c: Theme,
) {
  const min = Math.min(0, ...data);
  const max = Math.max(0, ...data);
  const span = max - min || 1;
  const px = (i: number) => x0 + (data.length > 1 ? (i / (data.length - 1)) * w : 0);
  const py = (v: number) => y0 + h - ((v - min) / span) * h;
  const zeroY = py(0);

  // Dashed zero reference.
  ctx.save();
  ctx.setLineDash([5, 5]);
  ctx.strokeStyle = withAlpha(c.text3, 0.5);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(x0, zeroY);
  ctx.lineTo(x0 + w, zeroY);
  ctx.stroke();
  ctx.restore();

  if (data.length < 2) return;

  // Smoothed (Catmull-Rom) point path, passing through every data point.
  const pts = data.map((v, i) => ({ x: px(i), y: py(v) }));

  // Area to the zero line.
  ctx.beginPath();
  traceSmooth(ctx, pts);
  ctx.lineTo(px(data.length - 1), zeroY);
  ctx.lineTo(px(0), zeroY);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, y0, 0, y0 + h);
  fill.addColorStop(0, withAlpha(color, 0.3));
  fill.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = fill;
  ctx.fill();

  // Line.
  ctx.beginPath();
  traceSmooth(ctx, pts);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = withAlpha(color, 0.6);
  ctx.shadowBlur = 14;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Endpoint marker.
  const ex = px(data.length - 1);
  const ey = py(data[data.length - 1]);
  ctx.beginPath();
  ctx.arc(ex, ey, 4, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.beginPath();
  ctx.arc(ex, ey, 8, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(color, 0.4);
  ctx.lineWidth = 2;
  ctx.stroke();
}

/** Trace a smooth (Catmull-Rom → bézier) path through `pts` onto the current
 *  canvas path — same curve the in-app equity chart draws, for consistency. */
function traceSmooth(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  if (pts.length === 0) return;
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    ctx.bezierCurveTo(c1x, c1y, c2x, c2y, p2.x, p2.y);
  }
}

/* ===================== variant: spotlight ===================== */

function drawSpotlight({ ctx, c, accent, sans, mono, d }: Ctx) {
  ctx.textAlign = 'center';

  ctx.font = `700 15px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('WIN RATE'), W / 2, 250);

  // Huge centered win-rate %.
  const heroText = pct(d.winRate, 1);
  const heroPx = fitSize(ctx, heroText, W - 2 * P, 220, 700, mono);
  ctx.font = `700 ${heroPx}px ${mono}`;
  ctx.fillStyle = accent;
  ctx.shadowColor = withAlpha(accent, 0.4);
  ctx.shadowBlur = 40;
  ctx.fillText(heroText, W / 2, 250 + heroPx * 0.82);
  ctx.shadowBlur = 0;

  const afterHero = 250 + heroPx * 0.82;

  // Record line.
  ctx.font = `500 24px ${mono}`;
  ctx.fillStyle = c.text2;
  ctx.fillText(recordLine(d), W / 2, afterHero + 48);

  // Realized PnL.
  ctx.font = `500 22px ${mono}`;
  ctx.fillStyle = d.realizedPnl >= 0 ? c.up : c.down;
  ctx.fillText(`${signed(d.realizedPnl)} DUSDC realized`, W / 2, afterHero + 84);

  ctx.textAlign = 'left';
}

/* ===================== shared pieces ===================== */

function drawStatStrip({ ctx, c, sans, mono, d }: Ctx) {
  ctx.textAlign = 'left';
  const stripY = 520;
  const hl = ctx.createLinearGradient(P, 0, W - P, 0);
  hl.addColorStop(0, 'rgba(255,255,255,0)');
  hl.addColorStop(0.5, c.line);
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fillRect(P, stripY, W - 2 * P, 1);

  const streak = d.streak
    ? d.streak.won
      ? winsLabel(d.streak.count)
      : `${d.streak.count}L`
    : '—';
  const cells: [string, string, string?][] = [
    ['REALIZED PNL', `${signed(d.realizedPnl)}`, d.realizedPnl >= 0 ? c.up : c.down],
    ['AVG ROI', d.staked > 0 ? pct(d.avgRoi, 1) : '—'],
    ['BEST', signed(d.best), d.best >= 0 ? c.up : undefined],
    ['STREAK', streak],
  ];
  const colW = (W - 2 * P) / cells.length;
  cells.forEach(([label, value, color], i) => {
    const x = P + i * colW;
    ctx.font = `500 12px ${sans}`;
    ctx.fillStyle = c.text3;
    ctx.fillText(spaced(label), x, stripY + 34);
    ctx.font = `500 22px ${mono}`;
    ctx.fillStyle = color ?? c.text1;
    ctx.fillText(value, x, stripY + 64);
  });
}

/** A right-aligned label pill (mirrors the position card's result pill, minus the
 *  live dot animation). */
function drawPill(
  ctx: CanvasRenderingContext2D,
  label: string,
  rightX: number,
  y: number,
  color: string,
  sans: string,
) {
  ctx.textAlign = 'left';
  ctx.font = `700 14px ${sans}`;
  const text = spaced(label);
  const tw = ctx.measureText(text).width;
  const dot = 8;
  const padX = 16;
  const gap = 9;
  const wPill = padX * 2 + dot + gap + tw;
  const h = 34;
  const x = rightX - wPill;
  roundRect(ctx, x, y, wPill, h, h / 2);
  ctx.fillStyle = withAlpha(color, 0.12);
  ctx.fill();
  ctx.strokeStyle = withAlpha(color, 0.4);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + padX + dot / 2, y + h / 2, dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.fillStyle = color;
  ctx.fillText(text, x + padX + dot + gap, y + h / 2 + 5);
}

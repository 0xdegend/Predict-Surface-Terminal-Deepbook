/**
 * Fear & Greed share-card renderer. Paints a 1200×675 poster of BTC's Fear & Greed
 * reading — a fear→greed gauge with a needle at the value, the big number, the
 * classification, a plain-language mood line, and the Skew fox reacting to the
 * mood (worried when fearful, confident when greedy). The co-pilot offers it as a
 * "Share to X" card under a fear & greed answer.
 *
 * Reuses the shared share-card toolkit (fonts, logo, fox art, roundRect) so the
 * card never drifts from the live UI, but keeps its own hex palette for the gauge
 * ramp math — the same reason the sentiment card does (theme tokens may resolve to
 * non-hex color spaces that can't be interpolated).
 */
import {
  SHARE_DIMS,
  fontFamily,
  loadShareLogo,
  getShareLogo,
  loadBrandMarks,
  getMascotMark,
  roundRect,
  spaced,
} from '@/app/_components/positions/share-card-canvas';

const { W, H, P } = SHARE_DIMS;

/** Hardcoded palette (matches the live theme) so the ramp interpolation is always
 *  on parseable hex, whatever color space the CSS tokens resolve to. */
const PAL = {
  bg: '#0a0b0d',
  t1: '#e6e8eb',
  t2: '#8b9099',
  t3: '#5a5f66',
  up: '#4dd6b0',
  down: '#f0796b',
  warn: '#e6b450',
  line: 'rgba(255,255,255,0.08)',
} as const;

type Rgb = [number, number, number];

function hexToRgb(hex: string): Rgb {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

const toHex2 = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');

/** Interpolate two #rrggbb colors, returning #rrggbb; t in [0,1]. Hex out keeps
 *  every color in this file parseable by `hexToRgb` / `rgbA`. */
function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const c = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return `#${toHex2(c(0))}${toHex2(c(1))}${toHex2(c(2))}`;
}

function rgbA(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** The fear→greed spectrum: coral (fear) → amber (neutral) → teal (greed). */
function rampColor(t: number): string {
  return t < 0.5 ? mix(PAL.down, PAL.warn, t / 0.5) : mix(PAL.warn, PAL.up, (t - 0.5) / 0.5);
}

/** The tier accent for a value — the one color the card leans on. */
export function fgTierColor(value: number): string {
  if (value <= 25) return PAL.down;
  if (value < 45) return mix(PAL.down, PAL.warn, 0.5);
  if (value <= 55) return PAL.warn;
  if (value < 75) return mix(PAL.warn, PAL.up, 0.5);
  return PAL.up;
}

/** Plain-language, no-jargon read of the mood — mirrors the co-pilot's chat copy. */
export function fgMoodLine(value: number): string {
  if (value <= 25) return 'The crowd is nervous and often over-selling.';
  if (value < 45) return 'People are leaning fearful. A cautious mood.';
  if (value <= 55) return 'The mood is roughly balanced between fear and greed.';
  if (value < 75) return 'People are leaning greedy. A confident, risk-on mood.';
  return 'The crowd is euphoric and often over-buying.';
}

/** The fox expression that matches the mood. */
function foxMood(value: number): 'won' | 'lost' | 'smart' | 'thinking' {
  if (value <= 25) return 'lost';
  if (value < 45) return 'thinking';
  if (value <= 55) return 'thinking';
  if (value < 75) return 'smart';
  return 'won';
}

function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  startPx: number,
  maxW: number,
  family: string,
): number {
  let px = startPx;
  ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > maxW && px > 34) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(test).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = test;
    }
  }
  if (cur) lines.push(cur);
  return lines;
}

/** A semicircular fear→greed gauge with a needle pointing at `value`, drawn around
 *  centre (gx, gy). The upper half spans canvas angles π → 2π (left → right). */
function drawGauge(
  ctx: CanvasRenderingContext2D,
  gx: number,
  gy: number,
  R: number,
  thickness: number,
  value: number,
  sans: string,
) {
  const tier = fgTierColor(value);
  const rMid = R - thickness / 2;

  // Soft pool of tier light behind the dial for depth.
  const glow = ctx.createRadialGradient(gx, gy - 20, 0, gx, gy - 20, R + 60);
  glow.addColorStop(0, rgbA(tier, 0.14));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(gx, gy - 20, R + 60, 0, Math.PI * 2);
  ctx.fill();

  // Faint full track under the coloured arc.
  ctx.strokeStyle = rgbA('#ffffff', 0.06);
  ctx.lineWidth = thickness + 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.arc(gx, gy, rMid, Math.PI, Math.PI * 2);
  ctx.stroke();

  // The ramp arc, drawn as many small segments (coral → amber → teal).
  const N = 72;
  ctx.lineCap = 'butt';
  ctx.lineWidth = thickness;
  for (let i = 0; i < N; i++) {
    const a0 = Math.PI + (i / N) * Math.PI;
    const a1 = Math.PI + ((i + 1) / N) * Math.PI + 0.006; // tiny overlap kills anti-alias seams
    ctx.strokeStyle = rampColor((i + 0.5) / N);
    ctx.beginPath();
    ctx.arc(gx, gy, rMid, a0, a1);
    ctx.stroke();
  }

  // Needle at the value angle (points up into the dial).
  const a = Math.PI + (value / 100) * Math.PI;
  const ux = Math.cos(a);
  const uy = Math.sin(a);
  const px = -uy;
  const py = ux;
  const tipR = R - thickness - 18;
  const baseW = 7;
  ctx.save();
  ctx.shadowColor = rgbA('#000000', 0.5);
  ctx.shadowBlur = 12;
  ctx.fillStyle = tier;
  ctx.beginPath();
  ctx.moveTo(gx + ux * tipR, gy + uy * tipR);
  ctx.lineTo(gx + px * baseW, gy + py * baseW);
  ctx.lineTo(gx - px * baseW, gy - py * baseW);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
  // Hub.
  ctx.fillStyle = tier;
  ctx.beginPath();
  ctx.arc(gx, gy, 13, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = PAL.bg;
  ctx.beginPath();
  ctx.arc(gx, gy, 5, 0, Math.PI * 2);
  ctx.fill();

  // End caps under the arc: FEAR (coral, left) · GREED (teal, right).
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 15px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.textAlign = 'left';
  ctx.fillStyle = PAL.down;
  ctx.fillText('FEAR', gx - R + 2, gy + 30);
  ctx.textAlign = 'right';
  ctx.fillStyle = PAL.up;
  ctx.fillText('GREED', gx + R - 2, gy + 30);
  ctx.letterSpacing = '0px';

  // The big value read, centred below the dial: "27" + "/100".
  ctx.textAlign = 'left';
  const big = String(Math.round(value));
  const suffix = ' /100';
  ctx.font = `700 84px ${sans}`;
  const bigW = ctx.measureText(big).width;
  ctx.font = `500 30px ${sans}`;
  const sufW = ctx.measureText(suffix).width;
  const groupX = gx - (bigW + sufW) / 2;
  const baseY = gy + 96;
  ctx.font = `700 84px ${sans}`;
  ctx.fillStyle = tier;
  ctx.fillText(big, groupX, baseY);
  ctx.font = `500 30px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(suffix, groupX + bigW, baseY);
  ctx.textAlign = 'left';
}

/**
 * Paint the fear & greed card onto `canvas`. Fonts + brand art must be loaded
 * first (`await document.fonts.ready`, `loadShareLogo()`, `loadBrandMarks()`).
 */
export function drawFearGreedCard(
  canvas: HTMLCanvasElement,
  data: { value: number; label: string },
  opts: { scale?: number } = {},
) {
  const scale = opts.scale ?? 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.resetTransform?.();
  ctx.scale(scale, scale);

  const sans = fontFamily('sans');
  const value = Math.max(0, Math.min(100, Math.round(data.value)));
  const tier = fgTierColor(value);

  // Base + a soft directional glow biased toward the gauge on the right.
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, W, H);
  const bgGlow = ctx.createRadialGradient(W * 0.74, H * 0.42, 0, W * 0.74, H * 0.42, 640);
  bgGlow.addColorStop(0, rgbA(tier, 0.13));
  bgGlow.addColorStop(1, 'rgba(10,11,13,0)');
  ctx.fillStyle = bgGlow;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = PAL.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);

  // Brand lockup, top-left — the real Skew mark + wordmark (mark falls back to a
  // simple rising-bars glyph until it decodes).
  const markSize = 40;
  const logo = getShareLogo();
  const markY = 60 - markSize / 2;
  if (logo) {
    ctx.drawImage(logo, P, markY, markSize, markSize);
  } else {
    const baseY = 72;
    [16, 26, 36].forEach((h, i) => {
      ctx.fillStyle = PAL.up;
      roundRect(ctx, P + i * 13, baseY - h, 8, h, 2);
      ctx.fill();
    });
  }
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillStyle = PAL.t1;
  ctx.font = `600 30px ${sans}`;
  ctx.fillText('Skew', P + markSize + 14, 61);

  // TESTNET pill, top-right.
  ctx.font = `600 14px ${sans}`;
  ctx.letterSpacing = '2px';
  const tnet = 'TESTNET';
  const pillW = ctx.measureText(tnet).width + 28;
  const pillH = 30;
  const pillX = W - P - pillW;
  const pillY = 60 - pillH / 2;
  ctx.fillStyle = rgbA(PAL.warn, 0.12);
  roundRect(ctx, pillX, pillY, pillW, pillH, 8);
  ctx.fill();
  ctx.fillStyle = PAL.warn;
  ctx.fillText(tnet, pillX + 14, 61);
  ctx.letterSpacing = '0px';

  // The gauge — the hero, on the right.
  drawGauge(ctx, 885, 320, 200, 32, value, sans);

  // Left column ---------------------------------------------------------------
  const colW = 540;
  ctx.textBaseline = 'alphabetic';

  // Eyebrow.
  ctx.font = `600 15px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = PAL.t3;
  ctx.fillText(spaced('FEAR & GREED INDEX'), P, 172);
  ctx.letterSpacing = '0px';

  // Lead-in.
  ctx.font = `400 26px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText('The market mood is', P, 216);

  // Big classification (the live label, uppercased), fit to the column.
  const bigLabel = data.label.toUpperCase();
  const labelPx = fitFont(ctx, bigLabel, 700, 74, colW, sans);
  ctx.font = `700 ${labelPx}px ${sans}`;
  ctx.fillStyle = tier;
  ctx.fillText(bigLabel, P, 292);

  // Plain-language mood line (wraps to at most two lines).
  ctx.font = `400 21px ${sans}`;
  ctx.fillStyle = PAL.t2;
  const moodLines = wrapLines(ctx, fgMoodLine(value), colW).slice(0, 2);
  moodLines.forEach((line, i) => ctx.fillText(line, P, 338 + i * 30));

  // The fox, reacting to the mood — bottom-left, over a faint pool of tier light.
  const fox = getMascotMark(foxMood(value));
  const foxSize = 158;
  const foxX = P + 4;
  const foxY = 430;
  const foxGlow = ctx.createRadialGradient(
    foxX + foxSize / 2,
    foxY + foxSize / 2,
    0,
    foxX + foxSize / 2,
    foxY + foxSize / 2,
    foxSize * 0.7,
  );
  foxGlow.addColorStop(0, rgbA(tier, 0.16));
  foxGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = foxGlow;
  ctx.fillRect(foxX - 30, foxY - 20, foxSize + 90, foxSize + 60);
  if (fox) ctx.drawImage(fox, foxX, foxY, foxSize, foxSize);

  // Footer — the data source (left) and the site + stack (right, website
  // emphasised as the destination).
  ctx.strokeStyle = PAL.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(P, 606);
  ctx.lineTo(W - P, 606);
  ctx.stroke();
  ctx.textAlign = 'left';

  // Left: "Data by OpenClawby" — the fear & greed reading comes through Clawby.
  const credit = 'Data by ';
  ctx.font = `400 15px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(credit, P, 640);
  const creditW = ctx.measureText(credit).width;
  ctx.font = `500 15px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText('OpenClawby', P + creditW, 640);

  // Right: the stack descriptor + the website, laid out so the group ends flush
  // at the right margin with the URL emphasised.
  const pre = 'DeepBook Predict on Sui · ';
  const site = 'tryskew.xyz';
  ctx.font = `400 15px ${sans}`;
  const preW = ctx.measureText(pre).width;
  ctx.font = `600 16px ${sans}`;
  const siteW = ctx.measureText(site).width;
  const rStart = W - P - preW - siteW;
  ctx.font = `400 15px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(pre, rStart, 640);
  ctx.font = `600 16px ${sans}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText(site, rStart + preW, 640);
}

/** Await the fonts + brand art the card needs, then it's safe to draw. */
export function loadFearGreedArt(): Promise<unknown> {
  return Promise.all([document.fonts?.ready, loadShareLogo(), loadBrandMarks()]);
}

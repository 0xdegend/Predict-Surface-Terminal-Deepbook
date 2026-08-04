/**
 * share-kit — the common chrome + color helpers for the branded share cards
 * (1200×675 posters). Factored out so each card renderer only writes its own hero
 * and reuses the identical frame, brand lockup, footer, fox, and ramp math.
 *
 * Reuses the low-level share toolkit from positions/share-card-canvas (fonts,
 * logo, fox art, roundRect) but keeps its own hardcoded hex palette so color
 * interpolation is always on parseable hex (theme tokens may be non-hex).
 */
import {
  fontFamily,
  loadShareLogo,
  getShareLogo,
  loadBrandMarks,
  getMascotMark,
  roundRect,
} from '@/app/_components/positions/share-card-canvas';

export { fontFamily };

/** The card palette — matches the live theme, hardcoded for safe interpolation. */
export const PAL = {
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

/** Interpolate two #rrggbb colors, returning #rrggbb (keeps everything parseable). */
export function mix(a: string, b: string, t: number): string {
  const pa = hexToRgb(a);
  const pb = hexToRgb(b);
  const c = (i: number) => Math.round(pa[i] + (pb[i] - pa[i]) * t);
  return `#${toHex2(c(0))}${toHex2(c(1))}${toHex2(c(2))}`;
}

/** Apply alpha to a #rrggbb color. */
export function rgbA(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${a})`;
}

/** Shrink a font until `text` fits `maxW` (weight/family fixed). Returns the px
 *  used. `minPx` is the floor it won't shrink below — pass one at/under `startPx`
 *  for small text (a floor above the start would leave the text unshrunk). */
export function fitFont(
  ctx: CanvasRenderingContext2D,
  text: string,
  weight: number,
  startPx: number,
  maxW: number,
  family: string,
  minPx = 30,
): number {
  let px = startPx;
  ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > maxW && px > minPx) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

/** Truncate `text` with a trailing "…" so it fits `maxW` at the CURRENT ctx.font.
 *  The safety net behind `fitFont`: once a label is as small as we'll allow, this
 *  guarantees it still can't run past its box (into a neighbouring pill). */
export function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  const ell = '…';
  let t = text;
  while (t.length > 0 && ctx.measureText(t + ell).width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + ell;
}

/** Greedy word-wrap for the current ctx.font, to `maxW`. */
export function wrapLines(ctx: CanvasRenderingContext2D, text: string, maxW: number): string[] {
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

/** Base ground + a soft directional glow (biased to `glowX`) + a hairline border. */
export function drawFrame(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  glowHex: string,
  glowX = 0.72,
  glowY = 0.4,
) {
  ctx.fillStyle = PAL.bg;
  ctx.fillRect(0, 0, W, H);
  const g = ctx.createRadialGradient(W * glowX, H * glowY, 0, W * glowX, H * glowY, 660);
  g.addColorStop(0, rgbA(glowHex, 0.13));
  g.addColorStop(1, 'rgba(10,11,13,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = PAL.line;
  ctx.lineWidth = 1;
  ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
}

/** Skew mark + wordmark (top-left) and a TESTNET pill (top-right). */
export function drawBrandHeader(ctx: CanvasRenderingContext2D, W: number, P: number, sans: string) {
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
  ctx.textBaseline = 'alphabetic';
}

export type FootSpan = { text: string; color: string; weight?: number; size?: number };

/** Footer: a hairline, then `left` spans from the left margin and `right` spans
 *  laid out flush to the right margin. Each span carries its own weight/size/color. */
export function drawFooter(
  ctx: CanvasRenderingContext2D,
  W: number,
  P: number,
  sans: string,
  left: FootSpan[],
  right: FootSpan[],
) {
  ctx.strokeStyle = PAL.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(P, 606);
  ctx.lineTo(W - P, 606);
  ctx.stroke();
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  const font = (s: FootSpan) => `${s.weight ?? 400} ${s.size ?? 15}px ${sans}`;

  let x = P;
  for (const s of left) {
    ctx.font = font(s);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, x, 640);
    x += ctx.measureText(s.text).width;
  }

  let total = 0;
  for (const s of right) {
    ctx.font = font(s);
    total += ctx.measureText(s.text).width;
  }
  let rx = W - P - total;
  for (const s of right) {
    ctx.font = font(s);
    ctx.fillStyle = s.color;
    ctx.fillText(s.text, rx, 640);
    rx += ctx.measureText(s.text).width;
  }
}

/** The site + stack descriptor as ready-made footer spans (URL emphasised). */
export function siteSpans(): FootSpan[] {
  return [
    { text: 'DeepBook Predict on Sui · ', color: PAL.t3 },
    { text: 'tryskew.xyz', color: PAL.t1, weight: 600, size: 16 },
  ];
}

/** The Skew fox reacting to a mood, over a faint pool of tinted light. */
export function drawFox(
  ctx: CanvasRenderingContext2D,
  mood: 'won' | 'lost' | 'smart' | 'thinking',
  x: number,
  y: number,
  size: number,
  glowHex: string,
) {
  const fox = getMascotMark(mood);
  const g = ctx.createRadialGradient(x + size / 2, y + size / 2, 0, x + size / 2, y + size / 2, size * 0.7);
  g.addColorStop(0, rgbA(glowHex, 0.16));
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.fillRect(x - 30, y - 20, size + 90, size + 60);
  if (fox) ctx.drawImage(fox, x, y, size, size);
}

/** Await the fonts + brand art every card needs before drawing. */
export function loadShareArt(): Promise<unknown> {
  return Promise.all([document.fonts?.ready, loadShareLogo(), loadBrandMarks()]);
}

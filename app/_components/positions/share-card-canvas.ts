/**
 * share-card-canvas.ts — paints a position as a shareable promotional card.
 *
 * Drawn directly with the Canvas 2D API (no html-to-image dependency, no
 * foreignObject font/CORS traps) so the output is a crisp, deterministic PNG we
 * can download, copy, or attach to a tweet. Every variant mirrors the terminal's
 * "engineered minimalism" tokens (§10.3) — dark base, a single semantic glow,
 * tabular figures — so a shared card reads as the same product.
 *
 * Three styles the user picks between:
 *   • glow      — hero ROI + the position's live probability sparkline (default)
 *   • spotlight — a big WIN / LIVE / LOSS word, meme-able, centered
 *   • surface   — the vol-surface wireframe as the hero, data overlaid
 *
 * 16:9 at 2× → 2400×1350 PNG, the size X renders an in-stream image at.
 */
import { signed, price, dateUTC, quote, pct } from '@/lib/format';

export interface ShareCardData {
  underlying: string;
  up: boolean;
  strike: number; // float
  expiry: number; // ms epoch
  result: 'live' | 'won' | 'lost';
  decided: boolean;
  pnl: number; // DUSDC, signed
  pnlPct: number; // ratio (e.g. 0.39 ⇒ +39%)
  cost: number; // DUSDC
  contracts: number;
  entryPrice: number; // 0..1
  markPrice: number | null; // 0..1
  spark: number[]; // implied-probability path over the holding window
  /** Present for a vertical-range card — renders the band instead of a strike. */
  band?: { lower: number; higher: number };
}

/** The bet line — a price band for ranges, else strike + direction. */
function betText(d: ShareCardData): string {
  if (d.band) return `${d.underlying} in $${price(d.band.lower)}–$${price(d.band.higher)}`;
  return `${d.underlying} ${d.up ? '≥' : '≤'} $${price(d.strike)}`;
}

/** The settlement-direction suffix on the subtitle. */
function outcomeText(d: ShareCardData): string {
  return d.band ? 'in band' : d.up ? 'UP' : 'DOWN';
}

export type ShareVariant = 'glow' | 'spotlight' | 'surface' | 'celebrate';

export const SHARE_VARIANTS: { id: ShareVariant; label: string }[] = [
  { id: 'glow', label: 'Glow' },
  { id: 'spotlight', label: 'Spotlight' },
  { id: 'surface', label: 'Surface' },
];

/**
 * Variants offered for a given result. The festive "Celebrate" card is win-only
 * — it leads the list for winners so the share dialog opens on the fun one — and
 * is simply absent for live/lost positions.
 */
export function shareVariants(
  result: ShareCardData['result'],
): { id: ShareVariant; label: string }[] {
  return result === 'won'
    ? [{ id: 'celebrate', label: 'Celebrate' }, ...SHARE_VARIANTS]
    : SHARE_VARIANTS;
}

const W = 1200;
const H = 675;
const P = 58; // outer padding

/** Logical card dimensions, shared with the performance share card. */
export const SHARE_DIMS = { W, H, P } as const;

export type Theme = ReturnType<typeof tokens>;

/** Read a CSS token off :root so the card never drifts from the live theme. */
export function tokens() {
  const css = getComputedStyle(document.documentElement);
  const t = (n: string, fallback: string) => css.getPropertyValue(n).trim() || fallback;
  return {
    bg: t('--bg-0', '#0a0b0d'),
    text1: t('--text-1', '#e6e8eb'),
    text2: t('--text-2', '#8b9099'),
    text3: t('--text-3', '#5a5f66'),
    up: t('--up', '#4dd6b0'),
    down: t('--down', '#f0796b'),
    warn: t('--warn', '#e6b450'),
    line: 'rgba(255,255,255,0.08)',
    lineSoft: 'rgba(255,255,255,0.05)',
  };
}

/** Resolve the page's actual Geist family names so canvas text matches the UI. */
export function fontFamily(kind: 'sans' | 'mono'): string {
  const probe = document.createElement('span');
  probe.style.cssText = `position:absolute;visibility:hidden;font-family:var(--font-geist-${kind})`;
  document.body.appendChild(probe);
  const ff = getComputedStyle(probe).fontFamily;
  probe.remove();
  return ff || (kind === 'mono' ? 'monospace' : 'system-ui, sans-serif');
}

/* Skew brand mark, loaded once and cached, for the card header. Same-origin
 * (/skew-mark.png) so it never taints the canvas → toBlob / clipboard still work.
 * The modal awaits this before drawing so the mark is present on first paint. */
let logoImg: HTMLImageElement | null = null;
let logoPromise: Promise<HTMLImageElement | null> | null = null;
export function loadShareLogo(): Promise<HTMLImageElement | null> {
  if (logoImg) return Promise.resolve(logoImg);
  if (!logoPromise) {
    logoPromise = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        logoImg = img;
        resolve(img);
      };
      img.onerror = () => resolve(null);
      img.src = '/skew-mark.png';
    });
  }
  return logoPromise;
}

/** The cached brand mark (or null if not yet loaded / failed) — `await
 *  loadShareLogo()` first. Lets the performance card reuse the same header mark. */
export function getShareLogo(): HTMLImageElement | null {
  return logoImg;
}

interface Ctx {
  ctx: CanvasRenderingContext2D;
  c: Theme;
  sans: string;
  mono: string;
  accent: string;
  d: ShareCardData;
}

/**
 * Paint a card onto `canvas`. Sizes the backing store for `scale` (2 = retina,
 * <1 = thumbnail) while all drawing math stays in logical 1200×675 space.
 *
 * Fonts must be ready before calling — `await document.fonts.ready` upstream.
 */
export function drawShareCard(
  canvas: HTMLCanvasElement,
  d: ShareCardData,
  opts: { variant?: ShareVariant; scale?: number; confetti?: boolean } = {},
) {
  const variant = opts.variant ?? 'glow';
  const scale = opts.scale ?? 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.resetTransform?.();
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';

  const c = tokens();
  // The card's one semantic color: teal won / coral lost / direction-tint live.
  const accent =
    d.result === 'won' ? c.up : d.result === 'lost' ? c.down : d.pnl >= 0 ? c.up : c.down;
  const s: Ctx = { ctx, c, sans: fontFamily('sans'), mono: fontFamily('mono'), accent, d };

  drawBackground(s, variant);
  if (variant === 'glow') drawGlow(s);
  else if (variant === 'spotlight') drawSpotlight(s);
  else if (variant === 'celebrate') drawCelebrate(s, opts.confetti ?? true);
  else drawSurface(s);
  drawHeader(s);
  drawFooter(s);
}

/* ===================== shared chrome ===================== */

function drawBackground({ ctx, c, accent }: Ctx, variant: ShareVariant) {
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  // Accent glow — spotlight pushes it to center-behind the hero word.
  const gx = variant === 'spotlight' ? W / 2 : W - 120;
  const gy = variant === 'spotlight' ? H / 2 : 120;
  const r = variant === 'spotlight' ? 520 : 620;
  const glow = ctx.createRadialGradient(gx, gy, 30, gx, gy, r);
  glow.addColorStop(0, withAlpha(accent, variant === 'spotlight' ? 0.2 : 0.16));
  glow.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  if (variant !== 'surface') {
    const glow2 = ctx.createRadialGradient(60, H - 40, 20, 60, H - 40, 460);
    glow2.addColorStop(0, withAlpha(accent, 0.07));
    glow2.addColorStop(1, withAlpha(accent, 0));
    ctx.fillStyle = glow2;
    ctx.fillRect(0, 0, W, H);
  }

  // Faint dot-grid texture — terminal substrate, barely there.
  ctx.fillStyle = 'rgba(255,255,255,0.022)';
  for (let y = 40; y < H; y += 30) {
    for (let x = 40; x < W; x += 30) {
      ctx.beginPath();
      ctx.arc(x, y, 0.7, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  // Result hairline along the very top.
  const rail = ctx.createLinearGradient(0, 0, W, 0);
  rail.addColorStop(0, withAlpha(accent, 0));
  rail.addColorStop(0.5, withAlpha(accent, 0.8));
  rail.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = rail;
  ctx.fillRect(0, 0, W, 3);
}

function drawHeader({ ctx, c, accent, sans, d }: Ctx) {
  const brandY = 78;
  const markSize = 30;
  if (logoImg) {
    ctx.drawImage(logoImg, P, brandY - 24, markSize, markSize);
  } else {
    // Fallback mark while the image loads — a teal brand dot.
    ctx.beginPath();
    ctx.arc(P + 8, brandY - 6, 6, 0, Math.PI * 2);
    ctx.fillStyle = c.up;
    ctx.fill();
  }

  const textX = P + markSize + 12;
  ctx.font = `600 30px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText('Skew', textX, brandY + 4);
  const brandW = ctx.measureText('Skew').width;
  drawTag(ctx, 'DEEPBOOK · SUI', textX + brandW + 14, brandY - 19, c.text3, c.line, sans);

  const resultText = d.result === 'won' ? 'WON' : d.result === 'lost' ? 'LOST' : 'LIVE';
  drawResultPill(ctx, resultText, W - P, brandY - 18, accent, d.result === 'live', sans);
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

/* ===================== variant: glow ===================== */

function drawGlow(s: Ctx) {
  const { ctx, c, accent, sans, mono, d } = s;
  const heroRight = 700;

  ctx.textAlign = 'left';
  ctx.font = `600 38px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(betText(d), P, 192);

  ctx.font = `400 18px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(
    `${d.decided ? 'Settled' : 'Settles'} ${dateUTC(d.expiry)} · ${outcomeText(d)}`,
    P,
    222,
  );

  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced(`${d.decided ? 'REALIZED' : 'UNREALIZED'} ROI`), P, 296);

  const roiText = `${signed(d.pnlPct * 100, 1)}%`;
  const roiPx = fitSize(ctx, roiText, heroRight - P - 24, 138, 700, mono);
  ctx.font = `700 ${roiPx}px ${mono}`;
  ctx.fillStyle = accent;
  const roiBaseline = 300 + roiPx * 0.78;
  ctx.fillText(roiText, P, roiBaseline);
  const roiW = ctx.measureText(roiText).width;
  ctx.fillStyle = withAlpha(accent, 0.5);
  ctx.fillRect(P, roiBaseline + 16, Math.min(roiW, heroRight - P - 24), 3);

  ctx.font = `500 26px ${mono}`;
  ctx.fillStyle = accent;
  const pnlStr = `${signed(d.pnl)} DUSDC`;
  ctx.fillText(pnlStr, P, roiBaseline + 56);
  ctx.font = `400 16px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(d.pnl >= 0 ? 'profit' : 'loss', P + ctx.measureText(pnlStr).width + 12, roiBaseline + 56);

  drawSparkline(ctx, d.spark, heroRight + 12, 168, W - P - (heroRight + 12), 300, accent, c);
  drawStatStrip(s);
}

/* ===================== variant: spotlight ===================== */

function drawSpotlight({ ctx, c, accent, sans, mono, d }: Ctx) {
  ctx.textAlign = 'center';

  // the bet, quiet, above the hero word
  ctx.font = `600 30px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(betText(d), W / 2, 215);
  ctx.font = `400 16px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(
    `${d.decided ? 'Settled' : 'Settles'} ${dateUTC(d.expiry)} · ${outcomeText(d)}`,
    W / 2,
    244,
  );

  // the hero word
  const word = d.result === 'won' ? 'WIN' : d.result === 'lost' ? 'LOSS' : 'LIVE';
  const wordPx = fitSize(ctx, word, W - 2 * P, 188, 800, sans);
  ctx.font = `800 ${wordPx}px ${sans}`;
  ctx.fillStyle = accent;
  ctx.shadowColor = withAlpha(accent, 0.4);
  ctx.shadowBlur = 40;
  ctx.fillText(word, W / 2, 430);
  ctx.shadowBlur = 0;

  // ROI + PnL beneath
  ctx.font = `700 40px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(`${signed(d.pnlPct * 100, 1)}%`, W / 2, 500);
  ctx.font = `500 22px ${mono}`;
  ctx.fillStyle = c.text2;
  ctx.fillText(`${signed(d.pnl)} DUSDC ${d.decided ? 'realized' : 'unrealized'}`, W / 2, 538);

  ctx.textAlign = 'left';
}

/* ===================== variant: celebrate ===================== */

/**
 * The win-only celebration card: seeded confetti, a gold burst, the Skew mark
 * "popped" in a glowing medallion, BIG WIN + the hero ROI. All canvas-drawn and
 * deterministic (confetti is seeded off the position) so the thumbnail, preview,
 * and exported PNG are pixel-identical. No photos, no likenesses.
 */
function drawCelebrate(s: Ctx, confetti = true) {
  const { ctx, c, sans, mono, d } = s;
  const win = c.up;
  const gold = c.warn;

  // Gold-into-teal burst behind the center.
  const burst = ctx.createRadialGradient(W / 2, 300, 40, W / 2, 300, 470);
  burst.addColorStop(0, withAlpha(gold, 0.16));
  burst.addColorStop(0.6, withAlpha(win, 0.06));
  burst.addColorStop(1, withAlpha(gold, 0));
  ctx.fillStyle = burst;
  ctx.fillRect(0, 0, W, H);

  if (confetti) drawConfetti(s, celebrateSeed(d));

  ctx.textAlign = 'center';

  // Celebrant medallion — the Skew mark, popped, with a teal glow ring.
  const mx = W / 2;
  const my = 150;
  const mr = 48;
  ctx.save();
  ctx.shadowColor = withAlpha(win, 0.6);
  ctx.shadowBlur = 30;
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(win, 0.12);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(mx, my, mr, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(win, 0.5);
  ctx.lineWidth = 2;
  ctx.stroke();
  if (logoImg) {
    const ls = 54;
    ctx.drawImage(logoImg, mx - ls / 2, my - ls / 2, ls, ls);
  } else {
    ctx.fillStyle = win;
    ctx.font = `700 34px ${sans}`;
    ctx.fillText('★', mx, my + 12);
  }
  drawSparkle(ctx, mx + 72, my - 26, 10, gold);
  drawSparkle(ctx, mx - 76, my - 8, 8, win);
  drawSparkle(ctx, mx + 86, my + 30, 7, c.text1);
  drawSparkle(ctx, mx - 70, my + 34, 6, gold);

  // Bet + settlement line.
  ctx.font = `600 28px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(betText(d), W / 2, 250);
  ctx.font = `400 16px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(
    `${d.decided ? 'Settled' : 'Settles'} ${dateUTC(d.expiry)} · ${outcomeText(d)}`,
    W / 2,
    278,
  );

  // BIG WIN eyebrow.
  ctx.font = `700 15px ${sans}`;
  ctx.fillStyle = gold;
  ctx.fillText(spaced('BIG WIN'), W / 2, 324);

  // Hero ROI, glowing.
  const roiText = `${signed(d.pnlPct * 100, 1)}%`;
  const roiPx = fitSize(ctx, roiText, W - 2 * P - 40, 112, 700, mono);
  const roiBaseline = 324 + roiPx * 0.82;
  ctx.font = `700 ${roiPx}px ${mono}`;
  ctx.fillStyle = win;
  ctx.shadowColor = withAlpha(win, 0.45);
  ctx.shadowBlur = 36;
  ctx.fillText(roiText, W / 2, roiBaseline);
  ctx.shadowBlur = 0;

  // PnL beneath.
  ctx.font = `500 24px ${mono}`;
  ctx.fillStyle = win;
  ctx.fillText(
    `${signed(d.pnl)} DUSDC ${d.decided ? 'realized' : 'unrealized'}`,
    W / 2,
    roiBaseline + 44,
  );

  drawStatStrip(s);
  ctx.textAlign = 'left';
}

/** Stable per-position seed so confetti is identical across renders. */
function celebrateSeed(d: ShareCardData): number {
  const base =
    Math.round(Math.abs(d.pnlPct) * 1000) +
    d.contracts * 7 +
    Math.round(d.cost * 100) +
    (d.expiry % 100000);
  return (base >>> 0) || 1;
}

/** Tiny deterministic PRNG (mulberry32) — keeps the card reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Festive paper ribbons scattered across the card (seeded). */
function drawConfetti({ ctx, c }: Ctx, seed: number) {
  const rng = mulberry32(seed);
  const colors = [c.up, c.warn, c.text1, '#9d92e8', '#6aa6e6'];
  for (let i = 0; i < 76; i++) {
    const x = rng() * W;
    const y = rng() * H;
    const len = 7 + rng() * 12;
    const wdt = 3 + rng() * 4;
    const rot = (rng() - 0.5) * Math.PI;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.globalAlpha = 0.35 + rng() * 0.45;
    ctx.fillStyle = colors[Math.floor(rng() * colors.length)];
    ctx.fillRect(-len / 2, -wdt / 2, len, wdt);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

/** A small four-point sparkle star. */
function drawSparkle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
) {
  ctx.save();
  ctx.translate(x, y);
  ctx.fillStyle = color;
  ctx.shadowColor = withAlpha(color, 0.7);
  ctx.shadowBlur = 10;
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2;
    const a2 = a + Math.PI / 4;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    ctx.lineTo(Math.cos(a2) * r * 0.36, Math.sin(a2) * r * 0.36);
  }
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

/* ===================== variant: surface ===================== */

function drawSurface(s: Ctx) {
  const { ctx, c, accent, sans, mono, d } = s;

  // The wireframe surface is the hero — fills the card behind a legibility wash.
  drawMesh(ctx, accent);
  const wash = ctx.createLinearGradient(0, 0, W * 0.7, H);
  wash.addColorStop(0, withAlpha(c.bg, 0.92));
  wash.addColorStop(0.55, withAlpha(c.bg, 0.55));
  wash.addColorStop(1, withAlpha(c.bg, 0));
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, W, H);

  ctx.textAlign = 'left';
  ctx.font = `600 36px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(betText(d), P, 250);
  ctx.font = `400 17px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(
    `${d.decided ? 'Settled' : 'Settles'} ${dateUTC(d.expiry)} · ${outcomeText(d)}`,
    P,
    278,
  );

  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced(`${d.decided ? 'REALIZED' : 'UNREALIZED'} ROI`), P, 350);
  const roiText = `${signed(d.pnlPct * 100, 1)}%`;
  const roiPx = fitSize(ctx, roiText, 560, 116, 700, mono);
  ctx.font = `700 ${roiPx}px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(roiText, P, 350 + roiPx * 0.82);

  ctx.font = `500 24px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(`${signed(d.pnl)} DUSDC`, P, 350 + roiPx * 0.82 + 42);

  drawStatStrip(s);
}

/** A faux-3D SVI smile surface: a glowing wireframe across the whole card. */
export function drawMesh(ctx: CanvasRenderingContext2D, color: string) {
  const cols = 18;
  const rows = 10;
  const cx = W * 0.62;
  const topY = 150;
  const depthY = 380;
  const spanX = 760;
  const lift = 150;

  const project = (u: number, v: number) => {
    const k = (u - 0.5) * 2;
    const smile = k * k; // 0 at center .. 1 at edges
    const z = smile * 0.7 + (1 - v) * 0.18; // taller at wings & near edge
    const persp = 1 - v * 0.32; // narrower toward the back
    const x = cx + (u - 0.5) * spanX * persp;
    const y = topY + v * depthY - z * lift;
    return { x, y, z };
  };

  ctx.lineWidth = 1;
  ctx.shadowColor = withAlpha(color, 0.5);
  ctx.shadowBlur = 8;

  // lines along strike (constant expiry)
  for (let r = 0; r < rows; r++) {
    const v = r / (rows - 1);
    ctx.beginPath();
    for (let cc = 0; cc < cols; cc++) {
      const u = cc / (cols - 1);
      const p = project(u, v);
      if (cc === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    ctx.strokeStyle = withAlpha(color, 0.1 + (1 - v) * 0.28);
    ctx.stroke();
  }
  // lines along expiry (constant strike)
  for (let cc = 0; cc < cols; cc++) {
    const u = cc / (cols - 1);
    ctx.beginPath();
    for (let r = 0; r < rows; r++) {
      const v = r / (rows - 1);
      const p = project(u, v);
      if (r === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    const edge = Math.abs(u - 0.5) * 2;
    ctx.strokeStyle = withAlpha(color, 0.08 + edge * 0.18);
    ctx.stroke();
  }
  ctx.shadowBlur = 0;
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

  const cells: [string, string][] = [
    ['COST', `${quote(d.cost)} DUSDC`],
    ['AVG ENTRY', pct(d.entryPrice, 1)],
    [d.decided ? 'SETTLED' : 'MARK', d.markPrice != null ? pct(d.markPrice, 1) : '—'],
  ];
  const colW = (W - 2 * P) / cells.length;
  cells.forEach(([label, value], i) => {
    const x = P + i * colW;
    ctx.font = `500 12px ${sans}`;
    ctx.fillStyle = c.text3;
    ctx.fillText(spaced(label), x, stripY + 34);
    ctx.font = `500 22px ${mono}`;
    ctx.fillStyle = c.text1;
    ctx.fillText(value, x, stripY + 64);
  });
}

function drawSparkline(
  ctx: CanvasRenderingContext2D,
  data: number[],
  x0: number,
  y0: number,
  w: number,
  h: number,
  color: string,
  c: Theme,
) {
  ctx.strokeStyle = c.lineSoft;
  ctx.lineWidth = 1;
  for (let i = 0; i <= 3; i++) {
    const y = y0 + (i / 3) * h;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + w, y);
    ctx.stroke();
  }

  if (data.length < 2) return; // too thin to plot — leave the framed grid

  const pad = 6;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const px = (i: number) => x0 + pad + (i / (data.length - 1)) * (w - 2 * pad);
  const py = (v: number) => y0 + h - pad - ((v - min) / span) * (h - 2 * pad);

  ctx.beginPath();
  ctx.moveTo(px(0), py(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(px(i), py(data[i]));
  ctx.lineTo(px(data.length - 1), y0 + h);
  ctx.lineTo(px(0), y0 + h);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, y0, 0, y0 + h);
  fill.addColorStop(0, withAlpha(color, 0.28));
  fill.addColorStop(1, withAlpha(color, 0));
  ctx.fillStyle = fill;
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(px(0), py(data[0]));
  for (let i = 1; i < data.length; i++) ctx.lineTo(px(i), py(data[i]));
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.shadowColor = withAlpha(color, 0.6);
  ctx.shadowBlur = 14;
  ctx.stroke();
  ctx.shadowBlur = 0;

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

/* ===================== primitives ===================== */

export function fitSize(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxW: number,
  startPx: number,
  weight: number,
  family: string,
  minPx = 40,
): number {
  let px = startPx;
  ctx.font = `${weight} ${px}px ${family}`;
  while (ctx.measureText(text).width > maxW && px > minPx) {
    px -= 2;
    ctx.font = `${weight} ${px}px ${family}`;
  }
  return px;
}

export function drawTag(
  ctx: CanvasRenderingContext2D,
  label: string,
  x: number,
  y: number,
  textColor: string,
  borderColor: string,
  sans: string,
) {
  ctx.textAlign = 'left';
  const text = spaced(label);
  ctx.font = `600 11px ${sans}`;
  const tw = ctx.measureText(text).width;
  const padX = 10;
  roundRect(ctx, x, y, tw + padX * 2, 22, 5);
  ctx.strokeStyle = borderColor;
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = textColor;
  ctx.fillText(text, x + padX, y + 15);
}

function drawResultPill(
  ctx: CanvasRenderingContext2D,
  label: string,
  rightX: number,
  y: number,
  color: string,
  live: boolean,
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
  if (live) {
    ctx.beginPath();
    ctx.arc(x + padX + dot / 2, y + h / 2, dot, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(color, 0.5);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
  ctx.fillStyle = color;
  ctx.fillText(text, x + padX + dot + gap, y + h / 2 + 5);
}

export function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, r);
  } else {
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }
}

/** Letter-space a label the way the .eyebrow micro-label does. */
export function spaced(s: string): string {
  return s.split('').join(' ');
}

/** Apply an alpha to a hex (#rgb/#rrggbb) color; passes others through. */
export function withAlpha(color: string, alpha: number): string {
  const hex = color.replace('#', '');
  if (/^[0-9a-f]{6}$/i.test(hex)) {
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  if (/^[0-9a-f]{3}$/i.test(hex)) {
    const r = parseInt(hex[0] + hex[0], 16);
    const g = parseInt(hex[1] + hex[1], 16);
    const b = parseInt(hex[2] + hex[2], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return color;
}

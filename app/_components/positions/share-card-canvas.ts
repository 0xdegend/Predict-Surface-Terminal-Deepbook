/**
 * share-card-canvas.ts — paints a position as a shareable promotional card.
 *
 * Drawn directly with the Canvas 2D API (no html-to-image dependency, no
 * foreignObject font/CORS traps) so the output is a crisp, deterministic PNG we
 * can download, copy, or attach to a tweet. Every variant mirrors the terminal's
 * "engineered minimalism" tokens (§10.3) — dark base, a single semantic glow,
 * tabular figures — so a shared card reads as the same product.
 *
 * The styles the user picks between:
 *   • glow      — hero ROI + the position's live probability sparkline (default)
 *   • spotlight — a big WIN / LIVE / LOSS word, meme-able, centered
 *   • surface   — the vol-surface wireframe as the hero, data overlaid
 *   • celebrate — win-only festive card (confetti + popped brand mark)
 *   • sui       — Sui-branded: the droplet mark in glowing water ripples
 *   • deepbook  — DeepBook-branded: the D mark over an order-book depth chart
 *   • mascot    — the Skew fox as the hero, expression keyed to the outcome
 *                 (confident point on a win/live, facepalm on a loss) + a speech bubble.
 *                 Wins also unlock two alternate poses (mascot-smart, mascot-thinking)
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

export type ShareVariant =
  | 'glow'
  | 'spotlight'
  | 'surface'
  | 'celebrate'
  | 'sui'
  | 'deepbook'
  | 'mascot'
  | 'mascot-smart'
  | 'mascot-thinking';

export const SHARE_VARIANTS: { id: ShareVariant; label: string }[] = [
  { id: 'mascot', label: 'Mascot' },
  { id: 'glow', label: 'Glow' },
  { id: 'spotlight', label: 'Spotlight' },
  { id: 'surface', label: 'Surface' },
  { id: 'sui', label: 'Sui' },
  { id: 'deepbook', label: 'DeepBook' },
];

/** Brand accents — used only by the `sui` / `deepbook` cards (a losing card
 *  still tints coral so the outcome reads, but wins/live carry the chain brand). */
const SUI_BLUE = '#4da2ff';
const DEEPBOOK_BLUE = '#2f7bff';

/**
 * Variants offered for a given result. The Mascot card leads the list (our brand
 * character is the showcase style); the festive "Celebrate" card is win-only and
 * slots in right after it, and is simply absent for live/lost positions.
 */
export function shareVariants(
  result: ShareCardData['result'],
): { id: ShareVariant; label: string }[] {
  if (result !== 'won') return SHARE_VARIANTS;
  // Wins unlock the extra mascot expressions (confident smirk / big-brain) and the
  // festive Celebrate card — all grouped right after the default Mascot card.
  const [mascot, ...rest] = SHARE_VARIANTS;
  return [
    mascot,
    { id: 'mascot-smart', label: 'Confident' },
    { id: 'mascot-thinking', label: 'Big brain' },
    { id: 'celebrate', label: 'Celebrate' },
    ...rest,
  ];
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

/* Generic same-origin image cache for the chain brand marks (DeepBook D / Sui
 * droplet) used by the `deepbook` / `sui` cards. Same-origin keeps the canvas
 * untainted so toBlob / clipboard still work. The white variants read cleanly on
 * the dark card and the brand color comes from the glow/motif around them. */
const SUI_MARK_SRC = '/Logo_Sui_Droplet_White.png';
const DEEPBOOK_MARK_SRC = '/DeepBook_Symbol_White.png';
// The Skew fox mascot expressions. A loss always shows the facepalm; wins/live
// default to the celebratory point, with two extra winning poses (a confident
// smirk + a "big brain" chin-stroke) offered as alternate Mascot styles.
const MASCOT_WON_SRC = '/skew-fox-won.png';
const MASCOT_LOSS_SRC = '/skew-fox-loss.png';
const MASCOT_SMART_SRC = '/smart-fox.png';
const MASCOT_THINKING_SRC = '/skew-fox-thinking.png';

/** Per-mascot-variant winning expression + its one-word reaction. The default
 *  `mascot` keeps the original point; the alternates are offered only on a win. */
const MASCOT_EXPR: Record<string, { src: string; wonQuip: string }> = {
  mascot: { src: MASCOT_WON_SRC, wonQuip: 'CALLED IT' },
  'mascot-smart': { src: MASCOT_SMART_SRC, wonQuip: 'TOO EASY' },
  'mascot-thinking': { src: MASCOT_THINKING_SRC, wonQuip: 'BIG BRAIN' },
};

/** True for any mascot card (default or an alternate winning expression). */
function isMascotVariant(v: ShareVariant): boolean {
  return v === 'mascot' || v === 'mascot-smart' || v === 'mascot-thinking';
}
const imgCache = new Map<string, HTMLImageElement | null>();
const imgPromises = new Map<string, Promise<HTMLImageElement | null>>();

function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (imgCache.has(src)) return Promise.resolve(imgCache.get(src) ?? null);
  let p = imgPromises.get(src);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        imgCache.set(src, img);
        resolve(img);
      };
      img.onerror = () => {
        imgCache.set(src, null);
        resolve(null);
      };
      img.src = src;
    });
    imgPromises.set(src, p);
  }
  return p;
}

/** Preload the DeepBook + Sui marks and the Skew mascot expressions. Await
 *  alongside `loadShareLogo()` before drawing a branded / `mascot` card so the
 *  artwork is present on first paint. */
export function loadBrandMarks(): Promise<unknown> {
  return Promise.all([
    loadImage(SUI_MARK_SRC),
    loadImage(DEEPBOOK_MARK_SRC),
    loadImage(MASCOT_WON_SRC),
    loadImage(MASCOT_LOSS_SRC),
    loadImage(MASCOT_SMART_SRC),
    loadImage(MASCOT_THINKING_SRC),
  ]);
}

function getMark(src: string): HTMLImageElement | null {
  return imgCache.get(src) ?? null;
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
  const semantic =
    d.result === 'won' ? c.up : d.result === 'lost' ? c.down : d.pnl >= 0 ? c.up : c.down;
  // Brand cards carry the chain accent on win/live, but stay coral on a loss so
  // the outcome still reads at a glance.
  const accent =
    variant === 'sui'
      ? d.result === 'lost'
        ? c.down
        : SUI_BLUE
      : variant === 'deepbook'
        ? d.result === 'lost'
          ? c.down
          : DEEPBOOK_BLUE
        : semantic;
  const s: Ctx = { ctx, c, sans: fontFamily('sans'), mono: fontFamily('mono'), accent, d };

  drawBackground(s, variant);
  if (variant === 'glow') drawGlow(s);
  else if (variant === 'spotlight') drawSpotlight(s);
  else if (variant === 'celebrate') drawCelebrate(s, opts.confetti ?? true);
  else if (variant === 'sui') drawSui(s);
  else if (variant === 'deepbook') drawDeepBook(s);
  else if (isMascotVariant(variant)) drawMascot(s, variant);
  else drawSurface(s);
  drawHeader(s);
  drawFooter(s);
}

/* ===================== shared chrome ===================== */

function drawBackground({ ctx, c, accent }: Ctx, variant: ShareVariant) {
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  // Accent glow — spotlight centers it; the brand/mascot cards bloom behind their
  // mark on the right; everything else hugs the top-right.
  const brand = variant === 'sui' || variant === 'deepbook' || isMascotVariant(variant);
  const gx = variant === 'spotlight' ? W / 2 : brand ? W * 0.78 : W - 120;
  const gy = variant === 'spotlight' ? H / 2 : brand ? 250 : 120;
  const r = variant === 'spotlight' ? 520 : brand ? 520 : 620;
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

/* ===================== variant: sui ===================== */

/**
 * Sui-branded card: the droplet mark glowing inside expanding water ripples on
 * the right, the position data on the left. Mirrors the `glow` split so the
 * family reads consistent; the ripples + droplet carry the Sui identity.
 */
function drawSui(s: Ctx) {
  const { ctx, c, accent, sans, mono, d } = s;
  const markX = W * 0.78;
  const markY = 268;

  // Concentric water ripples emanating from the droplet (the signature motif).
  // Kept tight so the faint outer ring never crosses the hero ROI on the left.
  drawRipples(ctx, markX, markY, accent, 5, 70, 44);
  // The droplet, glowing in a brand medallion.
  drawBrandMark(ctx, getMark(SUI_MARK_SRC), markX, markY, 132, accent, 'droplet');

  ctx.textAlign = 'left';
  const colW = markX - 150 - P; // keep the hero clear of the droplet

  ctx.font = `600 38px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(betText(d), P, 196);

  ctx.font = `400 18px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(
    `${d.decided ? 'Settled' : 'Settles'} ${dateUTC(d.expiry)} · ${outcomeText(d)}`,
    P,
    226,
  );

  ctx.font = `600 13px ${sans}`;
  ctx.fillStyle = accent;
  ctx.fillText(spaced('BUILT ON SUI'), P, 300);

  const roiText = `${signed(d.pnlPct * 100, 1)}%`;
  const roiPx = fitSize(ctx, roiText, colW, 134, 700, mono);
  const roiBaseline = 300 + roiPx * 0.82;
  ctx.font = `700 ${roiPx}px ${mono}`;
  ctx.fillStyle = accent;
  ctx.shadowColor = withAlpha(accent, 0.4);
  ctx.shadowBlur = 30;
  ctx.fillText(roiText, P, roiBaseline);
  ctx.shadowBlur = 0;

  ctx.font = `500 26px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(
    `${signed(d.pnl)} DUSDC ${d.decided ? 'realized' : 'unrealized'}`,
    P,
    roiBaseline + 50,
  );

  drawStatStrip(s);
}

/* ===================== variant: deepbook ===================== */

/**
 * DeepBook-branded card: the D mark glowing above a stylized order-book depth
 * chart on the right (the CLOB identity), position data on the left. Parallel
 * structure to the Sui card — mark medallion + brand motif + left data column.
 */
function drawDeepBook(s: Ctx) {
  const { ctx, c, accent, sans, mono, d } = s;
  const panelX = W * 0.55;
  const panelW = W - P - panelX;
  const markX = panelX + panelW / 2;
  const markY = 196;

  // Order-book depth silhouette beneath the mark — bids/asks meeting at mid.
  drawDepthChart(s, panelX, 286, panelW, 196, accent, depthSeed(d));
  // The DeepBook D, glowing in a brand medallion above the book.
  drawBrandMark(ctx, getMark(DEEPBOOK_MARK_SRC), markX, markY, 104, accent, 'rect');

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

  ctx.font = `600 13px ${sans}`;
  ctx.fillStyle = accent;
  ctx.fillText(spaced('POWERED BY DEEPBOOK'), P, 350);

  const roiText = `${signed(d.pnlPct * 100, 1)}%`;
  const roiPx = fitSize(ctx, roiText, panelX - P - 24, 116, 700, mono);
  const roiBaseline = 350 + roiPx * 0.82;
  ctx.font = `700 ${roiPx}px ${mono}`;
  ctx.fillStyle = accent;
  ctx.shadowColor = withAlpha(accent, 0.35);
  ctx.shadowBlur = 26;
  ctx.fillText(roiText, P, roiBaseline);
  ctx.shadowBlur = 0;

  ctx.font = `500 24px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(`${signed(d.pnl)} DUSDC`, P, roiBaseline + 42);

  drawStatStrip(s);
}

/* ===================== variant: mascot ===================== */

/**
 * The Skew mascot card: the fox is the hero on the right, its expression keyed to
 * the outcome — the confident point-up on a win or live position, the facepalm on
 * a loss — with a little speech bubble for personality. Position data sits in the
 * left column, mirroring the `sui` / `deepbook` split so the family reads
 * consistent. The semantic color (teal won/live, coral lost) carries the glow,
 * halo, and bubble, so the card's mood matches the result at a glance.
 */
function drawMascot(s: Ctx, variant: ShareVariant = 'mascot') {
  const { ctx, c, accent, sans, mono, d } = s;
  const loss = d.result === 'lost';
  // A loss always facepalms; otherwise use this variant's winning expression.
  const expr = MASCOT_EXPR[variant] ?? MASCOT_EXPR.mascot;
  const img = getMark(loss ? MASCOT_LOSS_SRC : expr.src);

  // Character hero, anchored to the bottom-right so it reads as standing in-card.
  const SZ = 432;
  const cx = 912;
  const bottom = H - 58;
  const haloY = bottom - SZ * 0.58;

  // Soft halo behind the fox (tighter than the background bloom).
  const halo = ctx.createRadialGradient(cx, haloY, 30, cx, haloY, 270);
  halo.addColorStop(0, withAlpha(accent, 0.22));
  halo.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = halo;
  ctx.fillRect(W * 0.42, 40, W * 0.58, H - 40);

  // Grounding shadow — a flattened ellipse under the character.
  ctx.save();
  ctx.translate(cx, bottom - 8);
  ctx.scale(1, 0.16);
  ctx.beginPath();
  ctx.arc(0, 0, 138, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fill();
  ctx.restore();

  // The fox, contained in an SZ box and anchored bottom-center.
  let headTopY = bottom - SZ; // fallback for the bubble anchor
  if (img) {
    const iw = img.naturalWidth || SZ;
    const ih = img.naturalHeight || SZ;
    const k = Math.min(SZ / iw, SZ / ih);
    const dw = iw * k;
    const dh = ih * k;
    headTopY = bottom - dh;
    ctx.drawImage(img, cx - dw / 2, bottom - dh, dw, dh);
  } else {
    // Fallback medallion so the card never renders empty.
    drawBrandMark(ctx, null, cx, haloY, 150, accent, 'droplet');
  }

  // Speech bubble above the head — the mascot's reaction, varied by expression.
  const quip = loss ? 'OUCH…' : d.result === 'won' ? expr.wonQuip : 'RIDING IT';
  drawSpeechBubble(ctx, cx, headTopY + 34, quip, accent, sans);

  /* Left data column — kept clear of the fox (left edge ≈ cx − SZ/2). */
  ctx.textAlign = 'left';
  const colW = cx - SZ / 2 - 36 - P;

  const betPx = fitSize(ctx, betText(d), colW, 38, 600, sans, 26);
  ctx.font = `600 ${betPx}px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(betText(d), P, 196);

  ctx.font = `400 18px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(
    `${d.decided ? 'Settled' : 'Settles'} ${dateUTC(d.expiry)} · ${outcomeText(d)}`,
    P,
    226,
  );

  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced(`${d.decided ? 'REALIZED' : 'UNREALIZED'} ROI`), P, 300);

  const roiText = `${signed(d.pnlPct * 100, 1)}%`;
  const roiPx = fitSize(ctx, roiText, colW, 134, 700, mono);
  const roiBaseline = 300 + roiPx * 0.82;
  ctx.font = `700 ${roiPx}px ${mono}`;
  ctx.fillStyle = accent;
  ctx.shadowColor = withAlpha(accent, 0.4);
  ctx.shadowBlur = 30;
  ctx.fillText(roiText, P, roiBaseline);
  ctx.shadowBlur = 0;

  ctx.font = `500 26px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(
    `${signed(d.pnl)} DUSDC ${d.decided ? 'realized' : 'unrealized'}`,
    P,
    roiBaseline + 50,
  );

  drawStatStrip(s);
}

/**
 * A rounded speech bubble with a downward tail tipped at (`tipX`, `tipY`). Used by
 * the mascot card to give the fox a one-word reaction. Text is centered.
 */
function drawSpeechBubble(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  text: string,
  color: string,
  sans: string,
) {
  ctx.font = `700 22px ${sans}`;
  const tw = ctx.measureText(text).width;
  const padX = 22;
  const padY = 14;
  const w = tw + padX * 2;
  const h = 22 + padY * 2;
  const x = tipX - w / 2;
  const y = tipY - 18 - h;

  // Tail — filled first so the bubble body covers its top edge cleanly.
  ctx.beginPath();
  ctx.moveTo(tipX - 13, y + h - 2);
  ctx.lineTo(tipX + 13, y + h - 2);
  ctx.lineTo(tipX, tipY);
  ctx.closePath();
  ctx.fillStyle = withAlpha(color, 0.16);
  ctx.fill();

  // Bubble body.
  roundRect(ctx, x, y, w, h, 16);
  ctx.fillStyle = withAlpha(color, 0.16);
  ctx.fill();
  ctx.strokeStyle = withAlpha(color, 0.5);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = color;
  ctx.textAlign = 'center';
  ctx.fillText(text, tipX, y + padY + 18);
  ctx.textAlign = 'left';
}

/** Expanding concentric rings — water ripples around the Sui droplet. */
function drawRipples(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  color: string,
  count: number,
  startR: number,
  step: number,
) {
  ctx.lineWidth = 1.5;
  for (let i = 0; i < count; i++) {
    ctx.beginPath();
    ctx.arc(cx, cy, startR + i * step, 0, Math.PI * 2);
    ctx.strokeStyle = withAlpha(color, 0.22 * (1 - i / count));
    ctx.stroke();
  }
}

/**
 * A brand mark inside a glowing medallion (teal/blue ring + soft halo). Uses the
 * cached white PNG; falls back to a simple drawn glyph (droplet or rounded
 * square) so the card never renders empty if the image failed to load.
 */
function drawBrandMark(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement | null,
  cx: number,
  cy: number,
  size: number,
  glow: string,
  fallback: 'droplet' | 'rect',
) {
  const ringR = size * 0.66;
  ctx.save();
  ctx.shadowColor = withAlpha(glow, 0.6);
  ctx.shadowBlur = 34;
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(glow, 0.12);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.arc(cx, cy, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = withAlpha(glow, 0.5);
  ctx.lineWidth = 2;
  ctx.stroke();

  if (img) {
    // Preserve the mark's native aspect ratio (object-fit: contain) — the
    // droplet is taller than wide and the D isn't square, so forcing a size×size
    // box stretched them. Fit inside the box, centered.
    const iw = img.naturalWidth || img.width || size;
    const ih = img.naturalHeight || img.height || size;
    const k = Math.min(size / iw, size / ih);
    const dw = iw * k;
    const dh = ih * k;
    ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
    return;
  }
  // Fallback glyph.
  ctx.fillStyle = glow;
  if (fallback === 'droplet') {
    const r = size * 0.34;
    ctx.beginPath();
    ctx.moveTo(cx, cy - r * 1.5);
    ctx.bezierCurveTo(cx + r * 1.3, cy - r * 0.2, cx + r, cy + r, cx, cy + r);
    ctx.bezierCurveTo(cx - r, cy + r, cx - r * 1.3, cy - r * 0.2, cx, cy - r * 1.5);
    ctx.fill();
  } else {
    roundRect(ctx, cx - size * 0.28, cy - size * 0.32, size * 0.56, size * 0.64, 8);
    ctx.fill();
  }
}

/** Stable per-position seed so the depth chart shape is reproducible. */
function depthSeed(d: ShareCardData): number {
  return (
    ((Math.round(Math.abs(d.pnlPct) * 1000) + d.contracts * 13 + Math.round(d.cost * 100) + d.expiry) >>>
      0) || 1
  );
}

/**
 * A stylized order-book depth chart: cumulative bid (left) and ask (right) step
 * areas rising toward a center mid line. Seeded so it's deterministic. Both
 * sides use the brand color (bids brighter, asks dimmer) so it reads as a book
 * without pulling in a competing green/red palette.
 */
function drawDepthChart(
  s: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  color: string,
  seed: number,
) {
  const { ctx } = s;
  const rng = mulberry32(seed);
  const steps = 9;
  const midX = x + w / 2;
  const baseY = y + h;

  // Build cumulative depth for each side (monotonic increasing toward mid).
  const side = () => {
    const arr: number[] = [];
    let cum = 0;
    for (let i = 0; i <= steps; i++) {
      cum += 0.4 + rng();
      arr.push(cum);
    }
    return arr;
  };
  const bids = side();
  const asks = side();
  const peak = Math.max(bids[steps], asks[steps]);
  const hY = (v: number) => baseY - (v / peak) * (h - 8);

  // Bid area — from left edge up to the mid.
  const bidStep = (midX - x) / steps;
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  for (let i = 0; i <= steps; i++) {
    const px = x + i * bidStep;
    ctx.lineTo(px, hY(bids[i]));
    if (i < steps) ctx.lineTo(px + bidStep, hY(bids[i])); // step
  }
  ctx.lineTo(midX, baseY);
  ctx.closePath();
  const bidFill = ctx.createLinearGradient(0, y, 0, baseY);
  bidFill.addColorStop(0, withAlpha(color, 0.34));
  bidFill.addColorStop(1, withAlpha(color, 0.04));
  ctx.fillStyle = bidFill;
  ctx.fill();

  // Ask area — from mid up to the right edge (dimmer).
  const askStep = (x + w - midX) / steps;
  ctx.beginPath();
  ctx.moveTo(midX, baseY);
  for (let i = 0; i <= steps; i++) {
    const px = midX + i * askStep;
    ctx.lineTo(px, hY(asks[i]));
    if (i < steps) ctx.lineTo(px + askStep, hY(asks[i]));
  }
  ctx.lineTo(x + w, baseY);
  ctx.closePath();
  const askFill = ctx.createLinearGradient(0, y, 0, baseY);
  askFill.addColorStop(0, withAlpha(color, 0.18));
  askFill.addColorStop(1, withAlpha(color, 0.02));
  ctx.fillStyle = askFill;
  ctx.fill();

  // The mid line — a glowing vertical seam where bids meet asks.
  ctx.beginPath();
  ctx.moveTo(midX, y - 4);
  ctx.lineTo(midX, baseY);
  ctx.strokeStyle = withAlpha(color, 0.5);
  ctx.lineWidth = 1.5;
  ctx.shadowColor = withAlpha(color, 0.6);
  ctx.shadowBlur = 10;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Baseline.
  ctx.beginPath();
  ctx.moveTo(x, baseY);
  ctx.lineTo(x + w, baseY);
  ctx.strokeStyle = withAlpha(color, 0.18);
  ctx.lineWidth = 1;
  ctx.stroke();
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

/**
 * trader-share-card-canvas.ts — paints a TRADER's public profile, or one of their
 * open bets, as a shareable promotional card. Companion to the position and
 * performance share cards; reuses the same chrome primitives (share-card-canvas.ts)
 * so anything shared reads as the same product.
 *
 * Two card kinds:
 *   • profile  — the trader's identity (jazzicon + address), Season-2 rank as the
 *                hero, and a Points / Volume / Trades strip. For "share this trader".
 *   • position — a bet-slip: the market on the left, and the pick + cost + odds +
 *                to-win on the right (layout inspired by a Polymarket share card,
 *                rendered in our dark "engineered minimalism" theme). For "share a
 *                bet this trader has open".
 *
 * 1200×675 (16:9) at 2× → 2400×1350 PNG.
 */
import { price, dateUTC, quote as fmtQuote, pct, num, compact, shortId } from '@/lib/format';
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
} from '@/app/_components/positions/share-card-canvas';

const { W, H, P } = SHARE_DIMS;

export interface TraderProfileShareData {
  trader: string; // wallet address (drives the jazzicon + short label)
  rank: number | null;
  ranked: number; // size of the ranked field
  points: number;
  volume: number; // DUSDC
  trades: number;
  archetype: string | null; // e.g. "Longshot hunter"
}

export interface TraderPositionShareData {
  trader: string; // whose bet this is (attribution + jazzicon)
  underlying: string; // 'BTC'
  direction: 'Up' | 'Down' | 'Range';
  strike?: number;
  band?: { lower: number; higher: number };
  expiry?: number; // ms epoch
  cost: number; // DUSDC paid
  odds: number; // 0..1 current implied probability
  toWin: number; // DUSDC payout if it wins
  leverage?: number;
}

/** A discriminated share target — the modal renders whichever kind it's handed. */
export type TraderShareCard =
  | { kind: 'profile'; data: TraderProfileShareData }
  | { kind: 'position'; data: TraderPositionShareData };

interface Base {
  ctx: CanvasRenderingContext2D;
  c: Theme;
  sans: string;
  mono: string;
}

function setup(canvas: HTMLCanvasElement, scale: number): Base | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.resetTransform?.();
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';
  return { ctx, c: tokens(), sans: fontFamily('sans'), mono: fontFamily('mono') };
}

/* ─────────────────────────── shared chrome ─────────────────────────── */

function drawBackground(b: Base, accent: string) {
  const { ctx, c } = b;
  ctx.fillStyle = c.bg;
  ctx.fillRect(0, 0, W, H);

  const glow = ctx.createRadialGradient(W - 140, 130, 30, W - 140, 130, 640);
  glow.addColorStop(0, withAlpha(accent, 0.15));
  glow.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);

  const glow2 = ctx.createRadialGradient(60, H - 40, 20, 60, H - 40, 460);
  glow2.addColorStop(0, withAlpha(accent, 0.07));
  glow2.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow2;
  ctx.fillRect(0, 0, W, H);

  // Faint dot-grid texture (same as the other cards).
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

function drawHeader(b: Base, pill: string, accent: string) {
  const { ctx, c, sans } = b;
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
  drawPill(ctx, pill, W - P, brandY - 18, accent, sans);
}

function drawFooter(b: Base) {
  const { ctx, c, sans } = b;
  ctx.textAlign = 'left';
  const y = H - 30;
  ctx.font = `600 15px ${sans}`;
  ctx.fillStyle = c.up;
  ctx.fillText('tryskew.xyz', P, y);
  const urlW = ctx.measureText('tryskew.xyz').width;
  ctx.font = `400 14px ${sans}`;
  ctx.fillStyle = c.text2;
  ctx.fillText('   ·   the live volatility surface · DeepBook Predict on Sui', P + urlW, y);

  ctx.font = `600 11px ${sans}`;
  const tnW = ctx.measureText(spaced('TESTNET')).width;
  drawTag(ctx, 'TESTNET', W - P - tnW - 22, H - 46, c.warn, withAlpha(c.warn, 0.3), sans);
}

/** Right-aligned label pill (mirrors the perf card's). */
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

/* ─────────────────────────── jazzicon (matches WalletAvatar) ─────────────────────────── */

const JAZZ_PALETTE = ['#4dd6b0', '#6aa6e6', '#9d92e8', '#d9a94e', '#f0796b', '#5fc9c0', '#b08be0', '#e0a36a'];

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draw the trader's deterministic identicon — same art as the in-app WalletAvatar,
 *  so their avatar is identical on the card as on the profile page. */
function drawJazzicon(ctx: CanvasRenderingContext2D, addr: string, cx: number, cy: number, r: number, ring: string) {
  let seed = 0;
  for (let i = 2; i < addr.length; i++) seed = (seed * 31 + addr.charCodeAt(i)) >>> 0;
  const rng = mulberry32(seed);
  const offset = Math.floor(rng() * JAZZ_PALETTE.length);
  const palette = JAZZ_PALETTE.slice(offset).concat(JAZZ_PALETTE.slice(0, offset));
  const size = r * 2;

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  ctx.translate(cx - r, cy - r); // into the identicon's own square coordinate space
  ctx.fillStyle = palette[0];
  ctx.fillRect(0, 0, size, size);

  const shapeCount = 4;
  for (let i = 0; i < shapeCount; i++) {
    const firstRot = rng();
    const angle = Math.PI * 2 * firstRot;
    const velocity = (size / shapeCount) * rng() + (i * size) / shapeCount;
    const tx = Math.cos(angle) * velocity;
    const ty = Math.sin(angle) * velocity;
    const rot = firstRot * 360 + rng() * 180;
    ctx.save();
    ctx.translate(tx, ty);
    ctx.translate(r, r);
    ctx.rotate((rot * Math.PI) / 180);
    ctx.translate(-r, -r);
    ctx.fillStyle = palette[(i + 1) % palette.length];
    ctx.fillRect(0, 0, size, size);
    ctx.restore();
  }

  // Soft top-light so the disc reads as a lit sphere (matches the SVG sheen).
  const sheen = ctx.createRadialGradient(size * 0.32, size * 0.26, size * 0.05, size * 0.32, size * 0.26, size * 0.75);
  sheen.addColorStop(0, 'rgba(255,255,255,0.32)');
  sheen.addColorStop(0.42, 'rgba(255,255,255,0.04)');
  sheen.addColorStop(1, 'rgba(0,0,0,0.28)');
  ctx.fillStyle = sheen;
  ctx.fillRect(0, 0, size, size);
  ctx.restore();

  // Ring.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = ring;
  ctx.lineWidth = 2;
  ctx.stroke();
}

/* ─────────────────────────── PROFILE card ─────────────────────────── */

export function drawTraderProfileCard(
  canvas: HTMLCanvasElement,
  d: TraderProfileShareData,
  opts: { scale?: number } = {},
) {
  const b = setup(canvas, opts.scale ?? 2);
  if (!b) return;
  const { ctx, c, sans, mono } = b;
  const accent = c.up;

  drawBackground(b, accent);
  drawHeader(b, 'TRADER', accent);

  // Identity band — jazzicon + short address + archetype.
  const avR = 54;
  const avCx = P + avR;
  const avCy = 188;
  drawJazzicon(ctx, d.trader, avCx, avCy, avR, withAlpha(accent, 0.45));

  const idX = avCx + avR + 26;
  ctx.textAlign = 'left';
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('TRADER'), idX, avCy - 26);
  ctx.font = `600 34px ${mono}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(shortId(d.trader, 8, 6), idX, avCy + 8);
  if (d.archetype) {
    ctx.font = `500 19px ${sans}`;
    ctx.fillStyle = c.text2;
    ctx.fillText(d.archetype, idX, avCy + 38);
  }

  // Hero — rank (or "unranked" when their markets have aged out of the window).
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('SEASON 2 RANK'), P, 320);
  if (d.rank != null) {
    const heroText = `#${d.rank}`;
    const heroPx = fitSize(ctx, heroText, 620, 150, 700, mono);
    const heroBaseline = 324 + heroPx * 0.8;
    ctx.font = `700 ${heroPx}px ${mono}`;
    ctx.fillStyle = accent;
    ctx.shadowColor = withAlpha(accent, 0.4);
    ctx.shadowBlur = 30;
    ctx.fillText(heroText, P, heroBaseline);
    ctx.shadowBlur = 0;
    ctx.font = `500 22px ${mono}`;
    ctx.fillStyle = c.text2;
    ctx.fillText(`of ${num(d.ranked, 0)} traders`, P, heroBaseline + 44);
  } else {
    ctx.font = `700 84px ${mono}`;
    ctx.fillStyle = c.text2;
    ctx.fillText('—', P, 430);
    ctx.font = `500 20px ${sans}`;
    ctx.fillStyle = c.text3;
    ctx.fillText('Not ranked in the current window', P, 470);
  }

  // Stat strip.
  drawStrip(b, [
    ['POINTS', num(d.points, 0), accent],
    ['VOLUME', `${compact(d.volume)}`, undefined, 'DUSDC'],
    ['TRADES', num(d.trades, 0)],
  ]);

  drawFooter(b);
}

/* ─────────────────────────── POSITION (bet-slip) card ─────────────────────────── */

export function drawTraderPositionCard(
  canvas: HTMLCanvasElement,
  d: TraderPositionShareData,
  opts: { scale?: number } = {},
) {
  const b = setup(canvas, opts.scale ?? 2);
  if (!b) return;
  const { ctx, c, sans, mono } = b;
  const isRange = d.direction === 'Range';
  const up = d.direction === 'Up';
  const accent = isRange ? c.up : up ? c.up : c.down;

  drawBackground(b, accent);
  drawHeader(b, 'OPEN BET', accent);

  // ── Left column: whose bet, the market, the settlement ──
  const orbCx = P + 30;
  const orbCy = 190;
  drawDirOrb(ctx, orbCx, orbCy, 30, d.direction, accent);

  ctx.textAlign = 'left';
  const venueX = orbCx + 30 + 20;
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('DEEPBOOK PREDICT'), venueX, orbCy - 6);
  ctx.font = `500 16px ${sans}`;
  ctx.fillStyle = c.text2;
  ctx.fillText(`${d.underlying} · binary`, venueX, orbCy + 18);
  if (isRange) {
    // overwrite the "binary" label for ranges
    ctx.fillStyle = c.bg;
    ctx.fillRect(venueX, orbCy + 4, 220, 20);
    ctx.fillStyle = c.text2;
    ctx.fillText(`${d.underlying} · range`, venueX, orbCy + 18);
  }

  // The market title, big.
  const rightColX = 700;
  const leftW = rightColX - P - 40;
  const title = isRange
    ? `${d.underlying} in $${price(d.band?.lower ?? 0)}–$${price(d.band?.higher ?? 0)}`
    : `${d.underlying} ${up ? '≥' : '≤'} $${price(d.strike ?? 0)}`;
  const titlePx = fitSize(ctx, title, leftW, 62, 700, mono, 30);
  ctx.font = `700 ${titlePx}px ${mono}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(title, P, 320);

  // Settlement + leverage.
  ctx.font = `500 19px ${sans}`;
  ctx.fillStyle = c.text2;
  ctx.fillText(d.expiry != null ? `Settles ${dateUTC(d.expiry, true)}` : 'Open position', P, 360);
  if (d.leverage && d.leverage > 1) {
    ctx.fillStyle = c.text3;
    const sw = ctx.measureText(d.expiry != null ? `Settles ${dateUTC(d.expiry, true)}` : 'Open position').width;
    drawTag(ctx, `${d.leverage}× LEVERAGE`, P + sw + 16, 344, c.warn, withAlpha(c.warn, 0.3), sans);
  }

  // Attribution — whose bet this is.
  ctx.font = `500 16px ${mono}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(`Trader ${shortId(d.trader, 6, 4)}`, P, leftW > 0 ? 470 : 470);

  // ── Right panel: the pick + cost + odds + to-win ──
  // Vertical divider (echoes the sample's split).
  ctx.fillStyle = c.line;
  ctx.fillRect(rightColX - 30, 150, 1, 360);

  const rx = rightColX;
  const rRight = W - P;

  // The pick — big, colored by side (like the sample's "Spain" in red).
  const pickLabel = isRange ? 'IN BAND' : up ? 'UP' : 'DOWN';
  ctx.textAlign = 'left';
  ctx.font = `700 46px ${sans}`;
  ctx.fillStyle = accent;
  ctx.shadowColor = withAlpha(accent, 0.35);
  ctx.shadowBlur = 24;
  ctx.fillText(pickLabel, rx, 214);
  ctx.shadowBlur = 0;

  // Cost + Odds rows.
  drawKV(b, 'Cost', `${fmtQuote(d.cost)}`, rx, rRight, 268, c.text1);
  drawKV(b, 'Odds', pct(d.odds, 0), rx, rRight, 312, c.text1);

  // Divider before the payout.
  ctx.fillStyle = c.line;
  ctx.fillRect(rx, 344, rRight - rx, 1);

  // To win — the hero of the panel.
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('TO WIN'), rx, 388);
  const payoutText = fmtQuote(d.toWin);
  const payoutPx = fitSize(ctx, payoutText, rRight - rx - 60, 52, 700, mono, 28);
  ctx.font = `700 ${payoutPx}px ${mono}`;
  ctx.fillStyle = accent;
  ctx.fillText(payoutText, rx, 388 + payoutPx * 0.82);
  ctx.font = `500 16px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText('DUSDC', rx, 388 + payoutPx * 0.82 + 26);

  drawFooter(b);
}

/** Direction orb — a ring with an up/down arrow or a range glyph (matches dir-orb). */
function drawDirOrb(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  r: number,
  dir: 'Up' | 'Down' | 'Range',
  accent: string,
) {
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fillStyle = withAlpha(accent, 0.12);
  ctx.fill();
  ctx.strokeStyle = withAlpha(accent, 0.5);
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = accent;
  ctx.strokeStyle = accent;
  ctx.lineWidth = 3;
  const a = r * 0.42;
  if (dir === 'Range') {
    ctx.beginPath();
    ctx.moveTo(cx - a, cy - a * 0.5);
    ctx.lineTo(cx + a, cy - a * 0.5);
    ctx.moveTo(cx - a, cy + a * 0.5);
    ctx.lineTo(cx + a, cy + a * 0.5);
    ctx.lineCap = 'round';
    ctx.stroke();
  } else {
    const upArrow = dir === 'Up';
    ctx.beginPath();
    if (upArrow) {
      ctx.moveTo(cx, cy - a);
      ctx.lineTo(cx + a, cy + a * 0.7);
      ctx.lineTo(cx - a, cy + a * 0.7);
    } else {
      ctx.moveTo(cx, cy + a);
      ctx.lineTo(cx + a, cy - a * 0.7);
      ctx.lineTo(cx - a, cy - a * 0.7);
    }
    ctx.closePath();
    ctx.fill();
  }
}

/** A label-left / value-right row inside the right panel. */
function drawKV(b: Base, label: string, value: string, x: number, rightX: number, y: number, valueColor: string) {
  const { ctx, c, sans, mono } = b;
  ctx.textAlign = 'left';
  ctx.font = `500 18px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(label, x, y);
  ctx.textAlign = 'right';
  ctx.font = `600 22px ${mono}`;
  ctx.fillStyle = valueColor;
  ctx.fillText(value, rightX, y);
  ctx.textAlign = 'left';
}

/** The bottom stat strip (Points / Volume / Trades) — matches the perf card. */
function drawStrip(b: Base, cells: [string, string, string?, string?][]) {
  const { ctx, c, sans, mono } = b;
  ctx.textAlign = 'left';
  const stripY = 520;
  const hl = ctx.createLinearGradient(P, 0, W - P, 0);
  hl.addColorStop(0, 'rgba(255,255,255,0)');
  hl.addColorStop(0.5, c.line);
  hl.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = hl;
  ctx.fillRect(P, stripY, W - 2 * P, 1);

  const colW = (W - 2 * P) / cells.length;
  cells.forEach(([label, value, color, unit], i) => {
    const x = P + i * colW;
    ctx.font = `500 12px ${sans}`;
    ctx.fillStyle = c.text3;
    ctx.fillText(spaced(label), x, stripY + 34);
    ctx.font = `500 22px ${mono}`;
    ctx.fillStyle = color ?? c.text1;
    ctx.fillText(value, x, stripY + 64);
    if (unit) {
      const vw = ctx.measureText(value).width;
      ctx.font = `500 13px ${sans}`;
      ctx.fillStyle = c.text3;
      ctx.fillText(unit, x + vw + 8, stripY + 64);
    }
  });
}

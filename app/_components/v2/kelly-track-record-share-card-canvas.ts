/**
 * kelly-track-record-share-card-canvas.ts — paints Kelly's Track Record as a
 * shareable 1200×675 poster. The hero is her VERIFIABLE win rate for the active
 * tab (forecasts or picks); a made / won / lost / settled strip carries the
 * counts, and the most recent signed calls list on the right with their outcome,
 * so the card proves the record rather than just claiming it.
 *
 * Same chrome primitives as the trader / position / fear & greed cards
 * (share-card-canvas.ts) so everything shared reads as the same product. The Skew
 * fox (won pose) is Kelly's face on the card, matching the page hero.
 */
import { pct, num } from '@/lib/format';
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
  loadShareLogo,
  loadBrandMarks,
  getMascotMark,
  type Theme,
} from '@/app/_components/positions/share-card-canvas';

const { W, H, P } = SHARE_DIMS;

export interface TrackRecordShareData {
  /** Which record this card shows — its own independent win rate. */
  tab: 'forecast' | 'pick';
  /** Win rate over settled calls (0..1); null when nothing has settled. */
  winRate: number | null;
  total: number;
  won: number;
  lost: number;
  settled: number;
  pending: number;
  /** The most recent calls (up to 3 drawn), newest first. */
  recent: { summary: string; outcome: 'won' | 'lost' | 'pending' }[];
}

export interface Base {
  ctx: CanvasRenderingContext2D;
  c: Theme;
  sans: string;
  mono: string;
}

export function setup(canvas: HTMLCanvasElement, scale: number): Base | null {
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.resetTransform?.();
  ctx.scale(scale, scale);
  ctx.textBaseline = 'alphabetic';
  return { ctx, c: tokens(), sans: fontFamily('sans'), mono: fontFamily('mono') };
}

/** Truncate with a trailing "…" so `text` fits `maxW` at the current ctx.font. */
function ellipsize(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  if (maxW <= 0) return '';
  if (ctx.measureText(text).width <= maxW) return text;
  let t = text;
  while (t.length > 0 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
  return t.trimEnd() + '…';
}

/* ─────────────────────────── shared chrome ─────────────────────────── */

export function drawBackground(b: Base, accent: string) {
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

export function drawHeader(b: Base, accent: string) {
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

  // "KELLY" pill, top-right.
  ctx.font = `700 14px ${sans}`;
  const label = spaced('KELLY');
  const tw = ctx.measureText(label).width;
  const dot = 8;
  const padX = 16;
  const gap = 9;
  const wPill = padX * 2 + dot + gap + tw;
  const h = 34;
  const x = W - P - wPill;
  const y = brandY - 18;
  roundRect(ctx, x, y, wPill, h, h / 2);
  ctx.fillStyle = withAlpha(accent, 0.12);
  ctx.fill();
  ctx.strokeStyle = withAlpha(accent, 0.4);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x + padX + dot / 2, y + h / 2, dot / 2, 0, Math.PI * 2);
  ctx.fillStyle = accent;
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.fillText(label, x + padX + dot + gap, y + h / 2 + 5);
}

export function drawFooter(b: Base) {
  const { ctx, c, sans } = b;
  ctx.textAlign = 'left';
  const y = H - 30;
  ctx.font = `600 15px ${sans}`;
  ctx.fillStyle = c.up;
  ctx.fillText('tryskew.xyz', P, y);
  const urlW = ctx.measureText('tryskew.xyz').width;
  ctx.font = `400 14px ${sans}`;
  ctx.fillStyle = c.text2;
  ctx.fillText('   ·   every call signed to Walrus · DeepBook Predict on Sui', P + urlW, y);

  ctx.font = `600 11px ${sans}`;
  const tnW = ctx.measureText(spaced('TESTNET')).width;
  drawTag(ctx, 'TESTNET', W - P - tnW - 22, H - 46, c.warn, withAlpha(c.warn, 0.3), sans);
}

/** The made / won / lost / settled strip (mirrors the trader/perf card). */
function drawStrip(b: Base, cells: [string, string, string?][]) {
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

/** Small outcome pill for a recent call — Won (teal) / Lost (coral) / Pending. */
function drawOutcome(b: Base, outcome: 'won' | 'lost' | 'pending', rightX: number, y: number) {
  const { ctx, c, sans } = b;
  const color = outcome === 'won' ? c.up : outcome === 'lost' ? c.down : c.text3;
  const label = outcome === 'won' ? 'WON' : outcome === 'lost' ? 'LOST' : 'PENDING';
  ctx.font = `700 12px ${sans}`;
  const text = spaced(label);
  const tw = ctx.measureText(text).width;
  const padX = 11;
  const h = 26;
  const w = tw + padX * 2;
  const x = rightX - w;
  roundRect(ctx, x, y - h / 2, w, h, h / 2);
  ctx.fillStyle = withAlpha(color, 0.13);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, x + padX, y + 1);
  ctx.textBaseline = 'alphabetic';
}

/* ─────────────────────────── the card ─────────────────────────── */

export function drawTrackRecordCard(
  canvas: HTMLCanvasElement,
  d: TrackRecordShareData,
  opts: { scale?: number } = {},
) {
  const b = setup(canvas, opts.scale ?? 2);
  if (!b) return;
  const { ctx, c, sans, mono } = b;
  const accent = c.up;
  const isForecast = d.tab === 'forecast';
  const heroColor = d.winRate == null ? c.text2 : d.winRate >= 0.5 ? c.up : c.down;

  drawBackground(b, accent);
  drawHeader(b, accent);

  // ── Identity band: Kelly (the won fox) + eyebrow + title ──
  const avSize = 92;
  const avX = P;
  const avY = 116;
  const fox = getMascotMark('won');
  const gx = avX + avSize / 2;
  const gy = avY + avSize / 2;
  const foxGlow = ctx.createRadialGradient(gx, gy, 0, gx, gy, avSize * 0.75);
  foxGlow.addColorStop(0, withAlpha(accent, 0.18));
  foxGlow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = foxGlow;
  ctx.fillRect(avX - 20, avY - 16, avSize + 60, avSize + 44);
  ctx.save();
  roundRect(ctx, avX, avY, avSize, avSize, 20);
  ctx.clip();
  ctx.fillStyle = '#0e1013';
  ctx.fillRect(avX, avY, avSize, avSize);
  if (fox) ctx.drawImage(fox, avX - 4, avY - 2, avSize + 8, avSize + 8);
  ctx.restore();
  roundRect(ctx, avX, avY, avSize, avSize, 20);
  ctx.strokeStyle = withAlpha(accent, 0.4);
  ctx.lineWidth = 1.5;
  ctx.stroke();

  const idX = avX + avSize + 24;
  ctx.textAlign = 'left';
  ctx.font = `600 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced('KELLY · VERIFIABLE CALLS'), idX, avY + 30);
  ctx.font = `700 32px ${sans}`;
  ctx.fillStyle = c.text1;
  ctx.fillText('Kelly’s Track Record', idX, avY + 70);

  // ── Hero: the win rate for this tab (left column) ──
  const heroY = 268;
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced(isForecast ? 'FORECAST WIN RATE' : 'PICK WIN RATE'), P, heroY);

  const heroText = d.winRate == null ? '—' : pct(d.winRate, 0);
  const heroPx = fitSize(ctx, heroText, 520, 168, 700, mono, 80);
  const heroBaseline = heroY + 28 + heroPx * 0.78;
  ctx.font = `700 ${heroPx}px ${mono}`;
  ctx.fillStyle = heroColor;
  ctx.shadowColor = withAlpha(heroColor, 0.4);
  ctx.shadowBlur = 30;
  ctx.fillText(heroText, P, heroBaseline);
  ctx.shadowBlur = 0;

  ctx.font = `500 20px ${sans}`;
  ctx.fillStyle = c.text2;
  const sub =
    d.settled > 0
      ? `over ${num(d.settled, 0)} settled ${isForecast ? 'forecast' : 'pick'}${d.settled === 1 ? '' : 's'}`
      : 'no calls settled yet';
  ctx.fillText(sub, P, heroBaseline + 40);

  // ── Recent calls (right column): the proof ──
  const rx = 640;
  ctx.font = `500 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced(isForecast ? 'RECENT FORECASTS' : 'RECENT PICKS'), rx, 172);

  const rows = d.recent.slice(0, 3);
  const rowH = 74;
  const rowTop = 210;
  const rowRight = W - P;
  rows.forEach((r, i) => {
    const ry = rowTop + i * rowH;
    // outcome pill (right), then the summary fit to the space left of it
    drawOutcome(b, r.outcome, rowRight, ry + 16);
    ctx.font = `700 12px ${sans}`;
    const pillW = ctx.measureText(spaced(r.outcome === 'won' ? 'WON' : r.outcome === 'lost' ? 'LOST' : 'PENDING')).width + 22;
    ctx.textAlign = 'left';
    ctx.font = `500 20px ${mono}`;
    ctx.fillStyle = c.text1;
    ctx.fillText(ellipsize(ctx, r.summary, rowRight - rx - pillW - 20), rx, ry + 22);
    // hairline under the row (not after the last)
    if (i < rows.length - 1) {
      ctx.strokeStyle = c.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(rx, ry + rowH - 22);
      ctx.lineTo(rowRight, ry + rowH - 22);
      ctx.stroke();
    }
  });
  if (rows.length === 0) {
    ctx.font = `400 18px ${sans}`;
    ctx.fillStyle = c.text3;
    ctx.fillText('Kelly’s calls show up here as she makes them.', rx, 232);
  }

  // ── Strip + footer ──
  drawStrip(b, [
    [isForecast ? 'FORECASTS' : 'PICKS', num(d.total, 0)],
    ['WON', num(d.won, 0), c.up],
    ['LOST', num(d.lost, 0), d.lost > 0 ? c.down : undefined],
    ['SETTLED', num(d.settled, 0)],
  ]);
  drawFooter(b);
}

/** Await the fonts + brand art the card needs, then it's safe to draw. */
export function loadTrackRecordArt(): Promise<unknown> {
  return Promise.all([document.fonts?.ready, loadShareLogo(), loadBrandMarks()]);
}

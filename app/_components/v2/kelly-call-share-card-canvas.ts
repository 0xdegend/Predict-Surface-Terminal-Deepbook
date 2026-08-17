/**
 * kelly-call-share-card-canvas.ts — paints a SINGLE Kelly call (one forecast or
 * one pick) as a shareable 1200×675 poster. Left: the call and Kelly's odds, when
 * it was made, when it settles, and the receipt id. Right: the Skew fox reacting
 * to the outcome with a big WON / LOST / PENDING verdict.
 *
 * Reuses the Track-Record card's frame / header / footer chrome so the two share
 * surfaces read as one, and the base share-card toolkit for the fox + helpers.
 */
import { dateUTC, shortId } from '@/lib/format';
import {
  SHARE_DIMS,
  withAlpha,
  fitSize,
  spaced,
  getMascotMark,
  loadShareLogo,
  loadBrandMarks,
} from '@/app/_components/positions/share-card-canvas';
import { setup, drawBackground, drawHeader, drawFooter } from './kelly-track-record-share-card-canvas';

const { W, P } = SHARE_DIMS;

export interface CallShareData {
  /** 'read' = a directional forecast, 'pick' = a concrete bet. */
  role: 'read' | 'pick';
  outcome: 'won' | 'lost' | 'pending';
  /** The one-line call, e.g. "BTC above $63,459 (74%)" or "Called BTC up from $64,000". */
  summary: string;
  createdAt: number; // ms
  expiry: number; // ms
  blobId: string;
}

/** Split a trailing "(NN%)" (Kelly's odds) off the summary so the headline is clean. */
function parseSummary(summary: string): { title: string; odds: string | null } {
  const m = summary.match(/^(.*?)\s*\((\d+)%\)\s*$/);
  return m ? { title: m[1].trim(), odds: `${m[2]}%` } : { title: summary, odds: null };
}

export function drawCallCard(canvas: HTMLCanvasElement, d: CallShareData, opts: { scale?: number } = {}) {
  const b = setup(canvas, opts.scale ?? 2);
  if (!b) return;
  const { ctx, c, sans, mono } = b;
  const isForecast = d.role === 'read';
  const won = d.outcome === 'won';
  const lost = d.outcome === 'lost';
  const accent = won ? c.up : lost ? c.down : c.up;
  const { title, odds } = parseSummary(d.summary);

  drawBackground(b, accent);
  drawHeader(b, accent);

  // ── Left column: the call ──
  const dividerX = 772;
  const leftW = dividerX - P - 40;

  ctx.textAlign = 'left';
  ctx.font = `600 13px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(spaced(isForecast ? 'KELLY · FORECAST' : 'KELLY · PICK'), P, 172);

  // The call itself, big.
  const titlePx = fitSize(ctx, title, leftW, 62, 700, mono, 30);
  ctx.font = `700 ${titlePx}px ${mono}`;
  ctx.fillStyle = c.text1;
  ctx.fillText(title, P, 258);

  // Kelly's odds (picks) or a directional-call note (forecasts).
  let y = 328;
  if (odds) {
    const lead = 'Kelly’s odds ';
    ctx.font = `500 23px ${sans}`;
    ctx.fillStyle = c.text2;
    ctx.fillText(lead, P, y);
    const lw = ctx.measureText(lead).width;
    ctx.font = `700 23px ${mono}`;
    ctx.fillStyle = accent;
    ctx.fillText(odds, P + lw, y);
  } else {
    ctx.font = `500 23px ${sans}`;
    ctx.fillStyle = c.text2;
    ctx.fillText('A directional call, scored at the price when she made it.', P, y);
  }

  // When made / when it settles.
  y = 392;
  ctx.font = `500 19px ${sans}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(`Called ${dateUTC(d.createdAt, true)}`, P, y);
  ctx.fillText(`${d.outcome === 'pending' ? 'Settles' : 'Settled'} ${dateUTC(d.expiry, true)}`, P, y + 30);

  // The receipt id — the content-addressed proof.
  ctx.font = `500 16px ${mono}`;
  ctx.fillStyle = c.text3;
  ctx.fillText(`Receipt ${shortId(d.blobId, 6, 4)}`, P, y + 74);

  // ── Right panel: Kelly reacting + the verdict ──
  ctx.fillStyle = c.line;
  ctx.fillRect(dividerX, 150, 1, 360);

  const panelCx = (dividerX + (W - P)) / 2;
  const fox = getMascotMark(won ? 'won' : lost ? 'lost' : 'thinking');
  const foxSize = 172;
  const foxX = panelCx - foxSize / 2;
  const foxY = 172;
  const glow = ctx.createRadialGradient(panelCx, foxY + foxSize / 2, 0, panelCx, foxY + foxSize / 2, foxSize * 0.72);
  glow.addColorStop(0, withAlpha(accent, 0.18));
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(foxX - 30, foxY - 20, foxSize + 60, foxSize + 60);
  if (fox) ctx.drawImage(fox, foxX, foxY, foxSize, foxSize);

  const verdict = won ? 'WON' : lost ? 'LOST' : 'PENDING';
  ctx.textAlign = 'center';
  ctx.font = `700 48px ${sans}`;
  ctx.fillStyle = accent;
  ctx.shadowColor = withAlpha(accent, 0.4);
  ctx.shadowBlur = 26;
  ctx.fillText(verdict, panelCx, foxY + foxSize + 58);
  ctx.shadowBlur = 0;
  ctx.textAlign = 'left';

  drawFooter(b);
}

/** Await the fonts + brand art the card needs, then it's safe to draw. */
export function loadCallArt(): Promise<unknown> {
  return Promise.all([document.fonts?.ready, loadShareLogo(), loadBrandMarks()]);
}

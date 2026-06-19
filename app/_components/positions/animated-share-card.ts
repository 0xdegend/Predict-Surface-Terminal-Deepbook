/**
 * animated-share-card.ts — turns the static share card into a looping GIF you
 * can attach to a tweet (X plays uploaded GIFs as looping video; it won't
 * animate a link-preview image, so this is a *download*, not a clipboard copy).
 *
 * We reuse the existing `drawShareCard` for the artwork (rendered once at full
 * res), then animate motion on top — a soft diagonal light "sheen" that sweeps
 * across the card — and encode the frames to GIF with gifenc. One global palette
 * (built from a mid-sweep frame so it captures both the card and the highlight)
 * keeps colors stable across frames and the file small.
 *
 * GIF, not WebM/MP4: X accepts GIF uploads, but MediaRecorder only emits WebM on
 * Chrome/Firefox (which X rejects), and cross-browser MP4 needs ffmpeg.wasm.
 */
import { GIFEncoder, quantize, applyPalette } from 'gifenc';
import { drawShareCard, loadShareLogo, loadBrandMarks, type ShareCardData, type ShareVariant } from './share-card-canvas';

// 16:9, downscaled from the 2400×1350 base to keep the GIF well under X's 15MB
// cap while staying crisp in-stream.
const OUT_W = 960;
const OUT_H = 540;
const FRAMES = 24;
const DELAY_MS = 55; // ~1.3s per loop

/** Soft diagonal light band sweeping across the card (the motion). `t` is the
 *  loop phase 0..1; the band travels off-screen → off-screen so the loop is seamless. */
function drawSheen(ctx: CanvasRenderingContext2D, t: number, w: number, h: number) {
  const center = (-0.35 + t * 1.7) * w; // off the left edge → off the right edge
  const half = w * 0.16;
  const g = ctx.createLinearGradient(center - half, 0, center + half, h);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.12)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.save();
  ctx.globalCompositeOperation = 'screen'; // add light, never darken
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

/* ---- falling confetti (celebrate variant only) -------------------------- */

const CONFETTI_COLORS = ['#4dd6b0', '#e6b450', '#e6e8eb', '#9d92e8', '#6aa6e6'];
const SPAN = OUT_H + 60; // vertical wrap range (a little above + below the card)

interface Confetto {
  x0: number;
  y0: number;
  len: number;
  wdt: number;
  rot0: number;
  turns: number;
  wraps: number;
  sway: number;
  swayCycles: number;
  alpha: number;
  color: string;
}

/** Deterministic per-position seed so a given win always animates the same. */
function confettiSeed(d: ShareCardData): number {
  return (
    ((Math.round(Math.abs(d.pnlPct) * 1000) + d.contracts * 7 + Math.round(d.cost * 100)) >>> 0) || 1
  );
}

function rng32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Build the confetti field. Fall speed, spin and sway are all INTEGER multiples
 *  of the loop, so the field wraps seamlessly (the frame at phase 1 == phase 0). */
function makeConfetti(seed: number): Confetto[] {
  const r = rng32(seed);
  return Array.from({ length: 80 }, () => ({
    x0: r() * OUT_W,
    y0: r() * SPAN,
    len: 6 + r() * 12,
    wdt: 2.5 + r() * 3.5,
    rot0: r() * Math.PI * 2,
    turns: 1 + Math.floor(r() * 3),
    wraps: 1 + Math.floor(r() * 2),
    sway: 6 + r() * 16,
    swayCycles: 1 + Math.floor(r() * 2),
    alpha: 0.3 + r() * 0.45,
    color: CONFETTI_COLORS[Math.floor(r() * CONFETTI_COLORS.length)],
  }));
}

/** Draw the field falling for loop phase `t` (0..1). */
function drawConfetti(ctx: CanvasRenderingContext2D, parts: Confetto[], t: number) {
  for (const p of parts) {
    const y = ((p.y0 + t * SPAN * p.wraps) % SPAN) - 30;
    const x = p.x0 + p.sway * Math.sin(2 * Math.PI * t * p.swayCycles);
    ctx.save();
    ctx.globalAlpha = p.alpha;
    ctx.translate(x, y);
    ctx.rotate(p.rot0 + t * 2 * Math.PI * p.turns);
    ctx.fillStyle = p.color;
    ctx.fillRect(-p.len / 2, -p.wdt / 2, p.len, p.wdt);
    ctx.restore();
  }
  ctx.globalAlpha = 1;
}

function compositeFrame(
  ctx: CanvasRenderingContext2D,
  base: HTMLCanvasElement,
  t: number,
  confetti: Confetto[] | null,
) {
  ctx.clearRect(0, 0, OUT_W, OUT_H);
  ctx.drawImage(base, 0, 0, OUT_W, OUT_H);
  if (confetti) drawConfetti(ctx, confetti, t); // falling, in front of the card
  drawSheen(ctx, t, OUT_W, OUT_H);
}

/**
 * Render the position card as a looping GIF blob. `onProgress` (0..1) drives the
 * button's progress label; we yield to the event loop periodically so it paints.
 */
export async function renderCardGif(
  data: ShareCardData,
  variant: ShareVariant,
  onProgress?: (frac: number) => void,
): Promise<Blob> {
  // Same prerequisites drawShareCard needs (fonts + the brand marks).
  await Promise.all([document.fonts.ready, loadShareLogo(), loadBrandMarks()]);

  // Artwork once, at full res; frames downscale from it. Skip the static
  // confetti on celebrate cards — we animate our own falling field per frame.
  const base = document.createElement('canvas');
  drawShareCard(base, data, { variant, confetti: false });

  const confetti = variant === 'celebrate' ? makeConfetti(confettiSeed(data)) : null;

  const frame = document.createElement('canvas');
  frame.width = OUT_W;
  frame.height = OUT_H;
  const ctx = frame.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('2D canvas unavailable');

  // Global palette from a mid-loop frame (so it includes the sheen + confetti).
  compositeFrame(ctx, base, 0.5, confetti);
  const mid = ctx.getImageData(0, 0, OUT_W, OUT_H).data;
  const palette = quantize(mid, 256);

  const gif = GIFEncoder();
  for (let i = 0; i < FRAMES; i++) {
    compositeFrame(ctx, base, i / FRAMES, confetti);
    const { data: rgba } = ctx.getImageData(0, 0, OUT_W, OUT_H);
    const index = applyPalette(rgba, palette);
    // Palette + infinite-loop flag on the first frame become the GIF's globals.
    gif.writeFrame(index, OUT_W, OUT_H, i === 0 ? { palette, delay: DELAY_MS, repeat: 0 } : { delay: DELAY_MS });
    onProgress?.((i + 1) / FRAMES);
    if (i % 5 === 4) await new Promise((r) => setTimeout(r)); // let the UI paint
  }
  gif.finish();
  // Copy into a fresh ArrayBuffer-backed view so it satisfies BlobPart.
  return new Blob([new Uint8Array(gif.bytes())], { type: 'image/gif' });
}

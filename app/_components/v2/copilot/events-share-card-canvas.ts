/**
 * Events share-card renderer. Paints a 1200×675 poster of today's market-moving
 * calendar — a numbered lineup of the day's big events (each with a "when" pill)
 * on the left, and the Skew fox (Kelly) watching the market on the right, under a
 * "Kelly reads the market for you" line. The co-pilot offers it as a "Share to X"
 * card under a "what's happening today?" answer, so it doubles as an ad for Kelly.
 *
 * Reuses the shared share-kit chrome (frame, brand header, footer, fox, palette)
 * so it never drifts from the other cards. Amber is its one accent — the
 * "heads-up / market watch" identity, distinct from the fear & greed ramp.
 */
import { SHARE_DIMS, roundRect, spaced } from '@/app/_components/positions/share-card-canvas';
import { utcTime } from '@/lib/insights/events';
import {
  fontFamily,
  PAL,
  rgbA,
  fitFont,
  drawFrame,
  drawBrandHeader,
  drawFooter,
  siteSpans,
  drawFox,
} from '@/app/_components/v2/share/share-kit';

const { W, H, P } = SHARE_DIMS;

export interface EventsShareData {
  events: { title: string; at: number | null; when: string }[];
  headline?: string | null;
}

/** Whether a "when" phrase points at something already out (vs still upcoming). */
function isPast(when: string): boolean {
  return /earlier|last couple|already/i.test(when);
}

/** Compact the relative time for a tight pill: "in about 15 hours" → "~15H". Only
 *  the fallback for events with no exact time; timed events show a UTC clock. */
function compactWhen(when: string): string {
  const w = when.toLowerCase();
  if (/within the hour/.test(w)) return 'SOON';
  if (/tomorrow/.test(w)) return 'TMRW';
  if (/last couple|earlier|already/.test(w)) return 'EARLIER';
  if (/later today/.test(w)) return 'LATER';
  const h = w.match(/in about (\d+)\s*hour/);
  if (h) return `~${h[1]}H`;
  return when.toUpperCase();
}

/** The pill label: the exact UTC time when the event has one (concrete + shareable,
 *  e.g. "13:30 UTC"), otherwise the compact relative phrase. */
function pillLabel(e: { at: number | null; when: string }): string {
  return e.at != null ? utcTime(e.at) : compactWhen(e.when);
}

/** The hero line, driven by the count so it always reads true. */
function heroLine(count: number): string {
  if (count <= 1) return 'A market-mover is on today’s calendar';
  return `${count} market-moving events today`;
}

/**
 * Paint the events card onto `canvas`. Fonts + brand art must be loaded first
 * (`loadShareArt()`), same as the other cards.
 */
export function drawEventsCard(canvas: HTMLCanvasElement, data: EventsShareData, opts: { scale?: number } = {}) {
  const scale = opts.scale ?? 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.resetTransform?.();
  ctx.scale(scale, scale);

  const sans = fontFamily('sans');
  const accent = PAL.warn;
  const events = data.events.slice(0, 5);

  // Ground + a warm spotlight biased toward Kelly on the right + hairline border.
  drawFrame(ctx, W, H, accent, 0.76, 0.36);
  drawBrandHeader(ctx, W, P, sans);

  // ── Left column: the event lineup ─────────────────────────────────────────
  const listW = 646; // P .. P+646
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';

  // Eyebrow.
  ctx.font = `600 15px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = accent;
  ctx.fillText(spaced('TODAY ON THE CALENDAR'), P, 132);
  ctx.letterSpacing = '0px';

  // Hero headline (fit to the column).
  const hero = heroLine(events.length);
  const heroPx = fitFont(ctx, hero, 700, 42, listW, sans);
  ctx.font = `700 ${heroPx}px ${sans}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText(hero, P, 186);

  // The rows.
  const rowH = 66;
  const top = 232;
  events.forEach((e, i) => {
    const y = top + i * rowH;
    const midY = y + rowH / 2;

    // Number chip.
    const chip = 40;
    const chipY = midY - chip / 2;
    ctx.fillStyle = rgbA(accent, 0.14);
    roundRect(ctx, P, chipY, chip, chip, 11);
    ctx.fill();
    ctx.fillStyle = accent;
    ctx.font = `700 18px ${sans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1).padStart(2, '0'), P + chip / 2, midY + 1);

    // "When" pill, right-aligned to the column edge — the exact UTC time when we
    // have it, else the relative phrase.
    const past = e.at != null ? e.at <= Date.now() : isPast(e.when);
    const pillText = pillLabel(e);
    const pillColor = past ? PAL.t2 : accent;
    ctx.font = `600 13px ${sans}`;
    ctx.letterSpacing = '1px';
    const pillTextW = ctx.measureText(pillText).width;
    const pillW = pillTextW + 24;
    const pillH = 28;
    const pillX = P + listW - pillW;
    ctx.fillStyle = past ? rgbA('#ffffff', 0.05) : rgbA(accent, 0.12);
    roundRect(ctx, pillX, midY - pillH / 2, pillW, pillH, 8);
    ctx.fill();
    ctx.fillStyle = pillColor;
    ctx.textAlign = 'center';
    ctx.fillText(pillText, pillX + pillW / 2, midY + 1);
    ctx.letterSpacing = '0px';

    // Title, fit to the space between chip and pill.
    const titleX = P + chip + 18;
    const titleMaxW = pillX - titleX - 16;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = PAL.t1;
    const tPx = fitFont(ctx, e.title, 600, 24, titleMaxW, sans);
    ctx.font = `600 ${tPx}px ${sans}`;
    ctx.fillText(e.title, titleX, midY + 1);

    // Hairline between rows.
    if (i < events.length - 1) {
      ctx.strokeStyle = PAL.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(P, y + rowH - 0.5);
      ctx.lineTo(P + listW, y + rowH - 0.5);
      ctx.stroke();
    }
  });

  // ── Right column: Kelly, watching ─────────────────────────────────────────
  const colX0 = P + listW + 46;
  const colCx = (colX0 + (W - P)) / 2;

  // The fox (Kelly), confident and on top of it, over a warm pool of light.
  const foxSize = 196;
  drawFox(ctx, 'smart', colCx - foxSize / 2, 150, foxSize, accent);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  // Kelly byline + tagline under the fox.
  ctx.font = `600 14px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = accent;
  ctx.fillText(spaced('KELLY IS WATCHING'), colCx, 392);
  ctx.letterSpacing = '0px';

  ctx.font = `700 27px ${sans}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText('Kelly reads the', colCx, 432);
  ctx.fillText('market for you', colCx, 466);

  ctx.font = `400 17px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText('Ask: what’s happening today?', colCx, 508);
  ctx.textAlign = 'left';

  // Footer: calendar source (left) + site (right).
  drawFooter(
    ctx,
    W,
    P,
    sans,
    [
      { text: 'Calendar by ', color: PAL.t3 },
      { text: 'OpenClawby', color: PAL.t2, weight: 500 },
    ],
    siteSpans(),
  );
}

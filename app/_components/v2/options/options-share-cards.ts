/**
 * Options-page share-card renderers. Three 1200×675 posters that double as ads for
 * the Options page:
 *  - market_read    — the plain-language "what BTC is doing + why" take, with the fox.
 *  - expected_range — the probable range by a horizon, as a labelled band.
 *  - bold_odds      — a big probability from the ladder, made to be argued with.
 *
 * All the frame / brand / footer / fox chrome comes from the shared share-kit; each
 * function here only paints its own hero. Fonts + brand art must be loaded first
 * (`loadShareArt()`), same as the other share dialogs.
 */
import { SHARE_DIMS, roundRect, spaced } from '@/app/_components/positions/share-card-canvas';
import { num } from '@/lib/format';
import type { OptionsShareCard } from '@/lib/share/options-share';
import {
  PAL,
  mix,
  rgbA,
  wrapLines,
  fontFamily,
  drawFrame,
  drawBrandHeader,
  drawFooter,
  siteSpans,
  drawFox,
} from '@/app/_components/v2/share/share-kit';

const { W, H, P } = SHARE_DIMS;

/** Fear→greed tint for the market-read fox/glow (mirrors the F&G card's tiers). */
function sentimentColor(v: number): string {
  if (v <= 25) return PAL.down;
  if (v < 45) return mix(PAL.down, PAL.warn, 0.5);
  if (v <= 55) return PAL.warn;
  if (v < 75) return mix(PAL.warn, PAL.up, 0.5);
  return PAL.up;
}
function sentimentFox(v: number): 'won' | 'lost' | 'smart' | 'thinking' {
  if (v <= 25) return 'lost';
  if (v < 55) return 'thinking';
  if (v < 75) return 'smart';
  return 'won';
}
function toneColor(tone: 'up' | 'down' | 'warn' | 'neutral'): string {
  return tone === 'up' ? PAL.up : tone === 'down' ? PAL.down : tone === 'warn' ? PAL.warn : PAL.t2;
}

/**
 * Paint an options share card. Sizes the backing store for `scale` (2 = retina)
 * while drawing in logical 1200×675 space.
 */
export function drawOptionsShareCard(
  canvas: HTMLCanvasElement,
  card: OptionsShareCard,
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
  const mono = fontFamily('mono');

  if (card.kind === 'market_read') drawMarketRead(ctx, card, sans);
  else if (card.kind === 'expected_range') drawExpectedRange(ctx, card, sans, mono);
  else drawBoldOdds(ctx, card, sans, mono);
}

function drawMarketRead(
  ctx: CanvasRenderingContext2D,
  card: Extract<OptionsShareCard, { kind: 'market_read' }>,
  sans: string,
) {
  const tint = card.sentiment ? sentimentColor(card.sentiment.value) : PAL.up;
  drawFrame(ctx, W, H, tint);
  drawBrandHeader(ctx, W, P, sans);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Eyebrow.
  ctx.font = `600 15px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = PAL.t3;
  ctx.fillText(spaced(`${card.asset} · MARKET READ`), P, 172);
  ctx.letterSpacing = '0px';

  // Headline — the hero, wrapped to at most three lines.
  ctx.font = `700 36px ${sans}`;
  ctx.fillStyle = PAL.t1;
  const headLines = wrapLines(ctx, card.headline, 720).slice(0, 3);
  headLines.forEach((line, i) => ctx.fillText(line, P, 228 + i * 46));

  // Driver lines — each with a tone dot, the "why" under the headline.
  let y = 228 + headLines.length * 46 + 34;
  for (const l of card.lines.slice(0, 3)) {
    if (y > 560) break;
    ctx.fillStyle = toneColor(l.tone);
    ctx.beginPath();
    ctx.arc(P + 5, y - 6, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.font = `400 19px ${sans}`;
    ctx.fillStyle = PAL.t2;
    const wrapped = wrapLines(ctx, l.text, 760).slice(0, 2);
    wrapped.forEach((line, i) => ctx.fillText(line, P + 24, y + i * 26));
    y += wrapped.length * 26 + 14;
  }

  // The fox reacting to the mood.
  drawFox(ctx, card.sentiment ? sentimentFox(card.sentiment.value) : 'thinking', 908, 402, 150, tint);

  // Footer — the reading blends Clawby data, so credit it.
  drawFooter(
    ctx,
    W,
    P,
    sans,
    [
      { text: 'Data by ', color: PAL.t3 },
      { text: 'OpenClawby', color: PAL.t2, weight: 500 },
    ],
    siteSpans(),
  );
}

function drawExpectedRange(
  ctx: CanvasRenderingContext2D,
  card: Extract<OptionsShareCard, { kind: 'expected_range' }>,
  sans: string,
  mono: string,
) {
  drawFrame(ctx, W, H, PAL.up);
  drawBrandHeader(ctx, W, P, sans);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Eyebrow + lead.
  ctx.font = `600 15px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = PAL.t3;
  ctx.fillText(spaced(`${card.asset} · EXPECTED RANGE · NEXT ${card.horizon.toUpperCase()}`), P, 172);
  ctx.letterSpacing = '0px';
  ctx.font = `400 26px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText('Expected to stay between', P, 236);

  // Low / high prices at the band ends.
  ctx.font = `700 46px ${mono}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText(`$${num(card.lowPrice, 0)}`, P, 322);
  ctx.textAlign = 'right';
  ctx.fillText(`$${num(card.highPrice, 0)}`, W - P, 322);
  ctx.textAlign = 'left';

  // The band + a marker for where the price sits now.
  const barY = 352;
  const barW = W - 2 * P;
  ctx.fillStyle = rgbA(PAL.up, 0.12);
  roundRect(ctx, P, barY, barW, 14, 7);
  ctx.fill();
  ctx.strokeStyle = rgbA(PAL.up, 0.42);
  ctx.lineWidth = 1;
  roundRect(ctx, P + 0.5, barY + 0.5, barW - 1, 13, 6.5);
  ctx.stroke();
  const pos =
    card.spot != null && card.highPrice > card.lowPrice
      ? Math.max(0, Math.min(1, (card.spot - card.lowPrice) / (card.highPrice - card.lowPrice)))
      : 0.5;
  const mx = P + pos * barW;
  ctx.fillStyle = PAL.t1;
  roundRect(ctx, mx - 1.5, barY - 7, 3, 28, 1.5);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(mx, barY - 8, 5, 0, Math.PI * 2);
  ctx.fill();

  // The takeaway.
  ctx.font = `600 24px ${sans}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText('About a 2 in 3 chance', P, 436);
  ctx.font = `400 18px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(`A move of about ±${card.sigmaPct.toFixed(2)}% either way`, P, 470);

  drawFox(ctx, 'thinking', 984, 452, 132, PAL.up);

  drawFooter(ctx, W, P, sans, [{ text: 'Live from the SVI surface', color: PAL.t3 }], siteSpans());
}

function drawBoldOdds(
  ctx: CanvasRenderingContext2D,
  card: Extract<OptionsShareCard, { kind: 'bold_odds' }>,
  sans: string,
  mono: string,
) {
  const odds = card.chancePct;
  const tint = odds >= 55 ? PAL.up : odds <= 45 ? PAL.down : PAL.warn;
  drawFrame(ctx, W, H, tint);
  drawBrandHeader(ctx, W, P, sans);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  // Eyebrow.
  ctx.font = `600 15px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = PAL.t3;
  ctx.fillText(spaced(`${card.asset} · THE MARKET SAYS`), P, 172);
  ctx.letterSpacing = '0px';

  // The big probability + the claim beside it.
  const big = `${Math.round(odds)}%`;
  ctx.font = `700 108px ${sans}`;
  ctx.fillStyle = tint;
  ctx.fillText(big, P, 322);
  const bigW = ctx.measureText(big).width;
  const cx = P + bigW + 40;
  ctx.font = `400 22px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText(`chance of ${card.isUp ? 'holding above' : 'staying below'}`, cx, 268);
  ctx.font = `700 40px ${mono}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText(`$${num(card.strike, 0)}`, cx, 312);
  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(`over the next ${card.horizon}`, cx, 348);

  // Payout, then the invite to disagree.
  const pays = 'Pays ';
  const mult = `${card.payoutX.toFixed(2)}×`;
  ctx.font = `400 22px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText(pays, P, 434);
  const paysW = ctx.measureText(pays).width;
  ctx.font = `600 22px ${sans}`;
  ctx.fillStyle = tint;
  ctx.fillText(mult, P + paysW, 434);
  const multW = ctx.measureText(mult).width;
  ctx.font = `400 22px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText(' if it wins', P + paysW + multW, 434);

  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText("Think it's wrong? Trade it.", P, 472);

  drawFox(ctx, odds >= 68 ? 'won' : odds >= 50 ? 'smart' : 'thinking', 984, 452, 132, tint);

  drawFooter(ctx, W, P, sans, [{ text: 'Live from the SVI surface', color: PAL.t3 }], siteSpans());
}

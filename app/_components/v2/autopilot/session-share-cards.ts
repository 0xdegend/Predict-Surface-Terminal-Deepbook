/**
 * Autopilot session share-card renderers. Three 1200×675 posters for a finished run:
 *  - session    — the headline result: net PnL, the record, how long Kelly ran, the plan,
 *                 with the fox reacting to the outcome.
 *  - curve      — the run trade by trade: the equity curve as the hero.
 *  - best_trade — the single best call, made to be bragged about.
 *
 * All the frame / brand / footer / fox chrome comes from the shared share-kit; each
 * function here only paints its own hero. Fonts + brand art must be loaded first
 * (`loadShareArt()`), same as the other share dialogs.
 */
import { SHARE_DIMS, roundRect, spaced, tokens } from '@/app/_components/positions/share-card-canvas';
import { drawCurve } from '@/app/_components/positions/perf-share-card-canvas';
import { money } from '@/lib/share/options-share';
import {
  durationWords,
  fmtUsd,
  tradeWords,
  type SessionShareData,
  type SessionShareKind,
} from '@/lib/share/autopilot-share';
import {
  PAL,
  rgbA,
  fitFont,
  wrapLines,
  fontFamily,
  drawFrame,
  drawBrandHeader,
  drawFooter,
  siteSpans,
  drawFox,
} from '@/app/_components/v2/share/share-kit';

const { W, H, P } = SHARE_DIMS;

/** Teal ahead, coral behind, amber for a flat run (a small dead-band reads flat). */
function outcomeTint(net: number): string {
  return net > 0.005 ? PAL.up : net < -0.005 ? PAL.down : PAL.warn;
}

function outcomeFox(net: number): 'won' | 'lost' | 'thinking' {
  return net > 0.005 ? 'won' : net < -0.005 ? 'lost' : 'thinking';
}

/**
 * Paint a session share card. Sizes the backing store for `scale` (2 = retina, <1 =
 * thumbnail) while drawing in logical 1200×675 space.
 */
export function drawSessionShareCard(
  canvas: HTMLCanvasElement,
  d: SessionShareData,
  opts: { kind?: SessionShareKind; scale?: number } = {},
) {
  const kind = opts.kind ?? 'session';
  const scale = opts.scale ?? 2;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  canvas.width = Math.round(W * scale);
  canvas.height = Math.round(H * scale);
  ctx.resetTransform?.();
  ctx.scale(scale, scale);

  const sans = fontFamily('sans');
  const mono = fontFamily('mono');

  if (kind === 'curve') drawCurveCard(ctx, d, sans);
  else if (kind === 'best_trade') drawBestTrade(ctx, d, sans, mono);
  else drawSession(ctx, d, sans, mono);
}

/** Eyebrow at the standard row, plus a right-aligned pill naming the plan + mode. */
function drawEyebrowRow(ctx: CanvasRenderingContext2D, d: SessionShareData, label: string, sans: string) {
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.font = `600 15px ${sans}`;
  ctx.letterSpacing = '2px';
  ctx.fillStyle = PAL.t3;
  ctx.fillText(spaced(label), P, 172);
  ctx.letterSpacing = '0px';

  // The plan + mode, as one quiet pill on the right of the eyebrow row.
  const plan = d.planName ? `${d.planName.toUpperCase()} PLAN` : 'CUSTOM PLAN';
  const mode = d.dryRun ? 'WATCH MODE' : 'LIVE';
  const text = spaced(`${plan} · ${mode}`);
  ctx.font = `600 12px ${sans}`;
  const tw = ctx.measureText(text).width;
  const pillW = tw + 28;
  const pillH = 28;
  const x = W - P - pillW;
  const y = 172 - 19;
  const tone = d.dryRun ? PAL.t2 : PAL.up;
  ctx.fillStyle = rgbA(tone, 0.1);
  roundRect(ctx, x, y, pillW, pillH, 8);
  ctx.fill();
  ctx.strokeStyle = rgbA(tone, 0.35);
  ctx.lineWidth = 1;
  ctx.stroke();
  ctx.fillStyle = tone;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 14, y + pillH / 2 + 1);
  ctx.textBaseline = 'alphabetic';
}

/** "Kelly picked every trade. ..." — the one-line explanation of what happened. */
function howLine(d: SessionShareData): string {
  return d.dryRun
    ? 'Kelly picked every trade and scored it against the real market. No money used.'
    : 'Kelly picked every trade. The session key placed them, no popups.';
}

function recordLine(d: SessionShareData): string {
  const rate = d.winRate != null ? ` · ${Math.round(d.winRate * 100)}% win rate` : '';
  return `${d.tradeCount} trade${d.tradeCount === 1 ? '' : 's'}${rate}${d.pending > 0 ? ` · ${d.pending} settling` : ''}`;
}

/* ------------------------------- session -------------------------------- */

function drawSession(ctx: CanvasRenderingContext2D, d: SessionShareData, sans: string, mono: string) {
  const tint = outcomeTint(d.netUsd);
  drawFrame(ctx, W, H, tint);
  drawBrandHeader(ctx, W, P, sans);
  drawEyebrowRow(ctx, d, 'AUTOPILOT · SESSION REPORT', sans);

  // The big net result + the record beside it.
  const big = fmtUsd(d.netUsd);
  const bigPx = fitFont(ctx, big, 700, 108, 520, sans, 64);
  ctx.font = `700 ${bigPx}px ${sans}`;
  ctx.fillStyle = tint;
  ctx.fillText(big, P, 322);
  const bigW = ctx.measureText(big).width;
  const cx = P + bigW + 40;
  ctx.font = `400 22px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText(`in ${durationWords(d.durationMs)}`, cx, 268);
  ctx.font = `700 40px ${mono}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText(`${d.wins}W / ${d.losses}L`, cx, 312);
  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(recordLine(d), cx, 348);

  // What happened, in one line.
  ctx.font = `400 22px ${sans}`;
  ctx.fillStyle = PAL.t2;
  wrapLines(ctx, howLine(d), 760)
    .slice(0, 2)
    .forEach((line, i) => ctx.fillText(line, P, 420 + i * 30));

  // Three stats, kept left of the fox.
  const cells: [string, string, string][] = [
    ['STAKED', `${money(d.stakedUsd)} of ${money(d.budgetUsd)}`, PAL.t1],
    ['BEST TRADE', d.best ? fmtUsd(d.best.pnlUsd) : '—', d.best ? PAL.up : PAL.t3],
    ['WORST DIP', d.maxDrawdownUsd > 0 ? fmtUsd(-d.maxDrawdownUsd) : 'none', d.maxDrawdownUsd > 0 ? PAL.down : PAL.t2],
  ];
  const stripY = 486;
  ctx.strokeStyle = PAL.line;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(P, stripY);
  ctx.lineTo(P + 780, stripY);
  ctx.stroke();
  const colW = 260;
  cells.forEach(([label, value, color], i) => {
    const x = P + i * colW;
    ctx.font = `600 13px ${sans}`;
    ctx.letterSpacing = '2px';
    ctx.fillStyle = PAL.t3;
    ctx.fillText(spaced(label), x, stripY + 32);
    ctx.letterSpacing = '0px';
    ctx.font = `600 26px ${mono}`;
    ctx.fillStyle = color;
    ctx.fillText(value, x, stripY + 68);
  });

  drawFox(ctx, outcomeFox(d.netUsd), 984, 452, 132, tint);

  drawFooter(
    ctx,
    W,
    P,
    sans,
    [
      { text: 'Ended · ', color: PAL.t3 },
      { text: d.endedWhy, color: PAL.t2, weight: 500 },
    ],
    siteSpans(),
  );
}

/* -------------------------------- curve --------------------------------- */

function drawCurveCard(ctx: CanvasRenderingContext2D, d: SessionShareData, sans: string) {
  const tint = outcomeTint(d.netUsd);
  drawFrame(ctx, W, H, tint, 0.78, 0.55);
  drawBrandHeader(ctx, W, P, sans);
  drawEyebrowRow(ctx, d, 'AUTOPILOT · TRADE BY TRADE', sans);

  // Left column: the net, the count, the dip, the how.
  const colW = 400;
  const big = fmtUsd(d.netUsd);
  const bigPx = fitFont(ctx, big, 700, 76, colW, sans, 48);
  ctx.font = `700 ${bigPx}px ${sans}`;
  ctx.fillStyle = tint;
  ctx.fillText(big, P, 292);
  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText(`${d.settledCount} settled trade${d.settledCount === 1 ? '' : 's'} in ${durationWords(d.durationMs)}`, P, 334);
  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = PAL.t3;
  const dip = d.maxDrawdownUsd > 0 ? `Worst dip ${fmtUsd(-d.maxDrawdownUsd)}` : 'Never went underwater';
  ctx.fillText(dip, P, 366);

  ctx.font = `400 18px ${sans}`;
  ctx.fillStyle = PAL.t3;
  wrapLines(ctx, howLine(d), colW)
    .slice(0, 3)
    .forEach((line, i) => ctx.fillText(line, P, 424 + i * 26));

  // The curve: running total after each settled trade, off the zero line.
  const plotX = P + colW + 60;
  drawCurve(ctx, [0, ...d.curve], plotX, 214, W - P - plotX, 330, tint, tokens());

  drawFooter(
    ctx,
    W,
    P,
    sans,
    [
      { text: 'Ended · ', color: PAL.t3 },
      { text: d.endedWhy, color: PAL.t2, weight: 500 },
    ],
    siteSpans(),
  );
}

/* ------------------------------ best trade ------------------------------ */

function drawBestTrade(ctx: CanvasRenderingContext2D, d: SessionShareData, sans: string, mono: string) {
  const t = d.best;
  if (!t) {
    drawSession(ctx, d, sans, mono);
    return;
  }
  drawFrame(ctx, W, H, PAL.up);
  drawBrandHeader(ctx, W, P, sans);
  drawEyebrowRow(ctx, d, 'AUTOPILOT · BEST CALL', sans);

  // The payout + the call beside it.
  const big = fmtUsd(t.pnlUsd);
  const bigPx = fitFont(ctx, big, 700, 108, 480, sans, 64);
  ctx.font = `700 ${bigPx}px ${sans}`;
  ctx.fillStyle = PAL.up;
  ctx.fillText(big, P, 322);
  const bigW = ctx.measureText(big).width;
  const cx = P + bigW + 40;
  ctx.font = `400 22px ${sans}`;
  ctx.fillStyle = PAL.t2;
  ctx.fillText(`on a ${money(t.stake)} stake`, cx, 268);
  const call = tradeWords(t);
  const callPx = fitFont(ctx, call, 700, 40, W - P - cx, mono, 24);
  ctx.font = `700 ${callPx}px ${mono}`;
  ctx.fillStyle = PAL.t1;
  ctx.fillText(call, cx, 312);
  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(`${Math.round(t.entryProb * 100)}% chance at entry`, cx, 348);

  // How it happened.
  ctx.font = `400 22px ${sans}`;
  ctx.fillStyle = PAL.t2;
  const how = d.dryRun
    ? 'Kelly picked it and scored it against the real market.'
    : 'Kelly picked it. The session key placed it while nobody was watching.';
  wrapLines(ctx, how, 760)
    .slice(0, 2)
    .forEach((line, i) => ctx.fillText(line, P, 434 + i * 30));

  ctx.font = `400 20px ${sans}`;
  ctx.fillStyle = PAL.t3;
  ctx.fillText(`One of ${d.tradeCount} trade${d.tradeCount === 1 ? '' : 's'} this session · ${d.wins}W / ${d.losses}L · ${fmtUsd(d.netUsd)} net`, P, 500);

  drawFox(ctx, 'smart', 984, 452, 132, PAL.up);

  drawFooter(
    ctx,
    W,
    P,
    sans,
    [
      { text: 'Ended · ', color: PAL.t3 },
      { text: d.endedWhy, color: PAL.t2, weight: 500 },
    ],
    siteSpans(),
  );
}

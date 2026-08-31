/**
 * The chart's hold-the-line gate: does the configured deployment's Pyth feed still give the
 * price chart enough history, at the resolution it plots?
 *
 * This is a MEASUREMENT, not a shape check. The paging budget is a tuned number
 * (`PYTH_HISTORY_MAX_PAGES = 18`), derived from two things that are properties of the feed
 * rather than of our code: how many observations per second the propbook publishes, and the
 * 50-event cap on a page. A republish that doubles the write rate silently halves the window
 * — the chart still renders, still looks live, and just quietly covers 90 seconds instead of
 * three minutes. Nothing throws and no test of shape would notice.
 *
 * So this asserts the OUTCOME the chart depends on: roughly one point per second, across a
 * window long enough to be worth drawing.
 *
 *   RUN_LIVE=1 npx vitest run lib/api/v2/chart-history.live.test.ts
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/api/v2/chart-history.live.test.ts
 *
 * Measured 2026-08-31, identical on both deployments: 180 points / 180 distinct seconds /
 * 179s span / ~7s to walk. 8-21 needed no retune.
 */
import { describe, it, expect } from 'vitest';
import { onchainPythObservations, onchainPythLatest } from './onchain';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';

const RUN = process.env.RUN_LIVE === '1';

/** What the chart asks for, and the floor below which the window stops being useful. */
const REQUESTED = 300;
const MIN_SECONDS = 120;

describe.skipIf(!RUN)(`pyth chart history on ${ACTIVE_V2_DEPLOYMENT} (live)`, () => {
  it('returns about one point per second over a window worth drawing', async () => {
    const started = Date.now();
    const obs = await onchainPythObservations(REQUESTED);
    const elapsed = Date.now() - started;

    const seconds = obs.map((o) => Math.floor((o.source_timestamp_ms ?? 0) / 1000)).filter(Boolean);
    const distinct = new Set(seconds).size;
    const span = seconds.length ? Math.max(...seconds) - Math.min(...seconds) : 0;
    console.log(
      `${ACTIVE_V2_DEPLOYMENT}: ${obs.length} points, ${distinct} distinct seconds, ` +
        `${span}s span (${(span / 60).toFixed(1)} min), walked in ${elapsed}ms`,
    );

    expect(span, `only ${span}s of history — the paging budget needs retuning for this feed`).toBeGreaterThanOrEqual(
      MIN_SECONDS,
    );
    // The walk decimates to one observation per second, so points and distinct seconds must
    // agree. A gap means the decimation key changed or two feeds are being mixed, which
    // renders as a square wave jumping between two price series rather than as an error.
    expect(distinct).toBe(obs.length);
    // Roughly one point per second across the span. Allows for genuine gaps in the feed.
    expect(obs.length / Math.max(span, 1)).toBeGreaterThan(0.8);
  }, 240_000);

  it('keeps every point on the configured feed, with prices in a sane band', async () => {
    // The event filter is MODULE-scoped, so it also sees any other feed the propbook writes
    // through `pyth_feed`. 8-21 moved `propbook_oracle_id` from field 0 to field 1 of the
    // observation event; it is read by name so the move is survivable, but if the field were
    // ever ABSENT the guard keeps the row, and two price series would be plotted as one.
    const obs = await onchainPythObservations(60);
    const feed = predictV2Config.asset.pythFeedId.toLowerCase();
    const tagged = obs.filter((o) => o.propbook_oracle_id?.startsWith('0x'));
    expect(tagged.length, 'no observation carries a feed id — the mixing guard is inert').toBeGreaterThan(0);
    for (const o of tagged) expect(o.propbook_oracle_id.toLowerCase()).toBe(feed);

    // A mixed series shows up as a wild spread long before it shows up as an error.
    const prices = obs.map((o) => Number(o.price_magnitude)).filter((p) => p > 0);
    const spread = Math.max(...prices) / Math.min(...prices);
    expect(spread, `prices span ${spread.toFixed(2)}x in one minute — two feeds are being mixed`).toBeLessThan(1.1);
  }, 120_000);

  it('agrees with the live spot read at the chart\'s live edge', async () => {
    // The history walk and the live-edge read are different code paths against different
    // sources (the event index vs the feed object). If they disagree the chart's last candle
    // jumps away from the price tape in the header.
    const [obs, spot] = await Promise.all([onchainPythObservations(10), onchainPythLatest()]);
    if (!spot) throw new Error('no live pyth observation');
    const newest = Number(obs[0]?.price_magnitude ?? 0);
    const live = Number(spot.price_magnitude);
    expect(newest).toBeGreaterThan(0);
    const drift = Math.abs(newest - live) / live;
    console.log(`live edge: history ${newest} vs live ${live} (${(drift * 100).toFixed(3)}%)`);
    expect(drift, 'the chart edge and the price tape disagree').toBeLessThan(0.01);
  }, 120_000);
});

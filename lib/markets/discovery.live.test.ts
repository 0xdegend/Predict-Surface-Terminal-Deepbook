/**
 * Does the board actually contain the long ladder?
 *
 * The 1-day and 1-week markets 8-21 added were live and tradeable on chain for ten days
 * while the app showed none of them: discovery walked `MarketCreated` newest-first, and
 * those events sit 48h and 336h back, far past any reachable window. The failure was
 * silent in the worst way — the board looked complete, just short.
 *
 * So this asserts the thing a screenshot would have shown: every enabled cadence has at
 * least one live market, and the long ones are reachable. It is a live test because the
 * bug only exists against a real venue; no fixture reproduces "the event stream does not
 * go back far enough".
 *
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/markets/discovery.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets } from '@/lib/api/v2/client';
import { onchainMarkets, onchainRegistryMarkets } from '@/lib/api/v2/onchain';
import { activeMarkets, groupByCadence, cadenceOf, CADENCE_ORDER } from '@/lib/markets/v2-discovery';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';

const RUN = process.env.RUN_LIVE === '1';
const enabled = predictV2Config.cadences.map((c) => c.name);

describe.skipIf(!RUN)(`market discovery on ${ACTIVE_V2_DEPLOYMENT} (live)`, () => {
  it('finds a live market for EVERY enabled cadence', async () => {
    const live = activeMarkets(await getV2Markets(100));
    const byCadence = groupByCadence(live);
    for (const c of CADENCE_ORDER) {
      const n = byCadence[c].length;
      const soonest = byCadence[c][0];
      console.log(
        `${c.padEnd(3)} ${String(n).padStart(2)} live` +
          (soonest ? `  next in ${((soonest.expiry - Date.now()) / 3600000).toFixed(2)}h` : ''),
      );
    }
    for (const c of enabled) {
      expect(byCadence[c as keyof typeof byCadence].length, `no live ${c} market on the board`).toBeGreaterThan(0);
    }
  }, 60_000);

  it('reaches markets the event walk cannot see', async () => {
    // The whole point of the registry read. If the event walk alone already covered the
    // long ladder this supplement would be dead weight, and if the registry read returned
    // nothing the union would silently degrade to the old, short board.
    const [events, registry] = await Promise.all([onchainMarkets(100), onchainRegistryMarkets()]);
    const seen = new Set(events.map((m) => m.expiry_market_id));
    const extra = registry.filter((m) => !seen.has(m.expiry_market_id));
    console.log(`events ${events.length} rows, registry ${registry.length}, registry-only ${extra.length}`);
    expect(registry.length, 'registry read returned nothing').toBeGreaterThan(0);
    const longCadences = enabled.filter((c) => c === '1d' || c === '1w');
    if (longCadences.length) {
      const fromEvents = new Set(events.map(cadenceOf));
      const fromUnion = new Set([...events, ...extra].map(cadenceOf));
      for (const c of longCadences) {
        expect(fromUnion.has(c as never), `union still missing ${c}`).toBe(true);
        console.log(`${c}: event walk ${fromEvents.has(c as never) ? 'saw it' : 'MISSED it'}, union sees it`);
      }
    }
  }, 60_000);

  it('gives every discovered market a usable strike grid', async () => {
    // A market with a zero admission tick renders no strikes, so it would appear on the
    // board and then refuse to be traded. The long ladder uses a $100 grid, not the $1
    // grid the sub-hour markets use, so this is exactly where a copied default would show.
    const live = activeMarkets(await getV2Markets(100));
    for (const m of live) {
      expect(Number(m.tick_size), `tick_size 0 on ${cadenceOf(m)} ${m.expiry_market_id}`).toBeGreaterThan(0);
      expect(
        Number(m.admission_tick_size),
        `admission_tick_size 0 on ${cadenceOf(m)} ${m.expiry_market_id}`,
      ).toBeGreaterThan(0);
    }
    const grids = new Map<string, string>();
    for (const m of live) grids.set(cadenceOf(m), m.admission_tick_size);
    console.log('admission grid by cadence:', Object.fromEntries(grids));
  }, 60_000);
});

/**
 * Can a long-ladder market actually be PRICED and TRADED, not just listed?
 *
 * Putting the 1-day and 1-week markets on the board is only useful if the rest of the
 * stack follows them there. These markets differ from the sub-hour ones in ways the app
 * has never exercised: a $100 admission grid instead of $1, and a time to expiry measured
 * in days rather than minutes, which is what the SVI pricer's sqrt(T) term reacts to.
 *
 * A market that lists but cannot be quoted is worse than one that never appeared, so this
 * asserts the whole read path per cadence: pricer loads, forward is sane, a strike on the
 * real grid quotes, and the quoted probability is inside (0,1).
 *
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/markets/long-tenor-quote.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets } from '@/lib/api/v2/client';
import { activeMarkets, groupByCadence, strikeGrid, CADENCE_ORDER } from '@/lib/markets/v2-discovery';
import { simulateLivePricer, v2GrpcClient, fairUp } from '@/lib/sui/v2/pricer';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { toFloat } from '@/config/scale';

const RUN = process.env.RUN_LIVE === '1';

describe.skipIf(!RUN)(`long-tenor pricing on ${ACTIVE_V2_DEPLOYMENT} (live)`, () => {
  it('loads a pricer and a sane fair value for every cadence on the board', async () => {
    const grouped = groupByCadence(activeMarkets(await getV2Markets(100)));
    const client = v2GrpcClient();
    const enabled = new Set(predictV2Config.cadences.map((c) => c.name));
    let checked = 0;

    for (const c of CADENCE_ORDER) {
      const m = grouped[c][0];
      if (!m) continue;
      const hrs = (m.expiry - Date.now()) / 3_600_000;
      const pricer = await simulateLivePricer(client, m.expiry_market_id);

      // The forward is the anchor for every strike on the card. A zero or absurd value
      // means the feed binding is wrong for this ladder, which would quote every long
      // market at a nonsense price rather than failing visibly.
      expect(pricer.forward, `${c}: forward not positive`).toBeGreaterThan(0);

      // Strikes come off the market's OWN admission grid, so this exercises the $100
      // grid on the long ladder and the $1 grid on the short one.
      const grid = strikeGrid(pricer.forward, m.admission_tick_size, 2);
      const atm = grid[Math.floor(grid.length / 2)];
      const up = fairUp(pricer, atm);
      expect(Number.isFinite(up), `${c}: fair UP not finite at strike ${atm}`).toBe(true);
      expect(up, `${c}: fair UP outside (0,1) at strike ${atm}`).toBeGreaterThan(0);
      expect(up).toBeLessThan(1);

      console.log(
        `${c.padEnd(3)} +${hrs.toFixed(2).padStart(7)}h  fwd ${pricer.forward.toFixed(0)}  ` +
          `grid $${toFloat(m.admission_tick_size)}  atm ${atm.toFixed(0)}  fairUP ${(up * 100).toFixed(1)}%`,
      );
      checked++;
      if (enabled.has(c)) expect(grouped[c].length).toBeGreaterThan(0);
    }
    // Guard against the test silently passing because the board was empty.
    expect(checked, 'no cadence had a market to price').toBeGreaterThanOrEqual(enabled.size);
  }, 120_000);

  it('prices a further-dated market as less certain than a near one', async () => {
    // A sanity check on the shape of the curve rather than a specific number: at the same
    // moneyness, more time to expiry means more uncertainty, so an out-of-the-money strike
    // must be MORE likely to be reached on the weekly than on the hourly. If the long
    // ladder were being priced with a wrong tenor this is what would break, and it would
    // break quietly — every individual quote would still look plausible.
    const grouped = groupByCadence(activeMarkets(await getV2Markets(100)));
    const near = grouped['1h'][0];
    const far = grouped['1w'][0] ?? grouped['1d'][0];
    if (!near || !far) return;
    const client = v2GrpcClient();
    const [pn, pf] = await Promise.all([
      simulateLivePricer(client, near.expiry_market_id),
      simulateLivePricer(client, far.expiry_market_id),
    ]);
    // +2% on each market's own forward, so both are the same distance out of the money.
    const upNear = fairUp(pn, pn.forward * 1.02);
    const upFar = fairUp(pf, pf.forward * 1.02);
    console.log(
      `+2% OTM: 1h ${(upNear * 100).toFixed(2)}%  vs  ` +
        `${grouped['1w'][0] ? '1w' : '1d'} ${(upFar * 100).toFixed(2)}%`,
    );
    expect(upFar, 'further-dated market priced as MORE certain than the near one').toBeGreaterThan(upNear);
  }, 120_000);
});

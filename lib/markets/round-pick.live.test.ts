/**
 * Live check that simple mode's tabs can no longer contradict their own labels.
 * Network-gated — runs only with RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/markets/round-pick.live.test.ts
 *
 * The old series-based rule failed this against the real chain: over 20 samples the
 * "1 min" tab exceeded a minute 25% of the time (the 1-minute series does not reliably
 * keep a rung in every minute) and the "1 hour" tab exceeded an hour 100% of the time
 * (the only hourly market is created ~3h ahead). At one sample the first two tabs were
 * outright inverted — 1m showing 1:58 while 5m showed 0:58 — which is what a trader
 * reported seeing.
 *
 * Fixtures can prove the rule; only the chain can prove the rule survives the ladder the
 * protocol actually produces, including the moments it skips a rung.
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets } from '@/lib/api/v2/client';
import { activeMarkets } from '@/lib/markets/v2-discovery';
import { SIMPLE_CADENCES } from '@/lib/markets/round-pick';
import { pickAllRounds, otherBandRounds, HORIZON_MS, type HeldPicks } from './round-pick';

const RUN = process.env.RUN_LIVE === '1';
const d = RUN ? describe : describe.skip;

const SAMPLES = 8;
const EVERY_MS = 11_000;
const mmss = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

d('round pick (live)', () => {
  it('never shows a round that outlives its tab, and never inverts the tabs', async () => {
    let held: HeldPicks = {};
    let populated = 0;

    for (let i = 0; i < SAMPLES; i++) {
      const now = Date.now();
      const active = activeMarkets(await getV2Markets(100), now);
      const picks = pickAllRounds(active, now, held);
      held = {
        '1m': picks['1m']?.expiry_market_id,
        '5m': picks['5m']?.expiry_market_id,
        '1h': picks['1h']?.expiry_market_id,
      };

      const lefts = SIMPLE_CADENCES.map((c) => (picks[c] ? picks[c]!.expiry - now : null));
      console.log(
        `${new Date(now).toISOString().slice(11, 19)}  ` +
          SIMPLE_CADENCES.map((c, k) => `${c}=${lefts[k] == null ? 'none' : mmss(lefts[k]!)}`).join('  '),
      );

      SIMPLE_CADENCES.forEach((c, k) => {
        const left = lefts[k];
        if (left == null) return;
        // THE invariant: a tab never offers a round longer than the tab promises.
        expect(left, `${c} tab showed ${mmss(left)}`).toBeLessThanOrEqual(HORIZON_MS[c]);
      });

      // Tabs must read in order — the inversion the trader saw is a sorted-order failure.
      const present = lefts.filter((v): v is number => v != null);
      for (let k = 1; k < present.length; k++) {
        expect(present[k], 'tabs out of order').toBeGreaterThan(present[k - 1]);
      }

      // And no two tabs may offer the SAME market.
      const ids = SIMPLE_CADENCES.map((c) => picks[c]?.expiry_market_id).filter(Boolean);
      expect(new Set(ids).size).toBe(ids.length);

      // EVERY EXTRA CARD gets the same guarantee as a tab. This is the rule that lets us
      // offer the whole ladder instead of one round per tab: a card is only ever labelled
      // with a band it fits inside, so "5 min" can't show 6 minutes however many are up.
      const extras = otherBandRounds(active, now, picks['1m']?.expiry_market_id, 99);
      const heroIds = new Set(ids);
      for (const r of extras) {
        const left = r.market.expiry - now;
        expect(left, `${r.cadence} card showed ${mmss(left)}`).toBeLessThanOrEqual(HORIZON_MS[r.cadence]);
        expect(left, `${r.cadence} card already expired`).toBeGreaterThan(0);
      }
      expect(new Set(extras.map((r) => r.market.expiry_market_id)).size).toBe(extras.length);
      expect(extras.some((r) => r.market.expiry_market_id === picks['1m']?.expiry_market_id)).toBe(false);
      console.log(
        `   offered: ${extras.length + (heroIds.size ? 1 : 0)} of ${active.length} live  ` +
          extras.map((r) => `${r.cadence}:${mmss(r.market.expiry - now)}`).join(' '),
      );

      if (picks['1m']) populated++;
      if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, EVERY_MS));
    }

    console.log(`\n1 min tab had a round in ${populated}/${SAMPLES} samples`);
    // The band being briefly empty is allowed and handled in the UI, but if it were
    // usually empty the tab would be useless and this rule would be the wrong trade.
    expect(populated).toBeGreaterThan(SAMPLES / 2);
  }, 300_000);
});

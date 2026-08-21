/**
 * Live census of the DEAD ZONE: how much of a round's life is its pinned line no longer
 * a two-way bet? Network-gated — runs only with RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/sui/v2/simple-round.live.test.ts
 *
 * A trader reported landing on a round with real time left and both sides refusing to
 * quote. That is not a pricing bug: the line is fixed at the round's open, and once spot
 * has walked a few sigma away with the clock running down, UP is worth ~1.00 and DOWN
 * ~0.00, so BOTH fail the quotable gate at the same instant.
 *
 * This walks the live ladder and reports, per sample, the fair UP probability at the
 * pinned line against the time left. It is the evidence for how aggressive the
 * re-anchoring rule needs to be, and it stays as the check that the rule works.
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets } from '@/lib/api/v2/client';
import { activeMarkets, CADENCE_ORDER } from '@/lib/markets/v2-discovery';
import { pickAllRounds, type HeldPicks } from '@/lib/markets/round-pick';
import { getV2MarketState } from '@/lib/api/v2/client';
import { simulateLivePricer, v2GrpcClient, fairUp } from '@/lib/sui/v2/pricer';
import { tickToStrike } from '@/lib/sui/v2/ticks';
import { toFloat } from '@/config/scale';
import { lineIsTradeable } from './simple-round';

const RUN = process.env.RUN_LIVE === '1';
const d = RUN ? describe : describe.skip;

const SAMPLES = 18;
const EVERY_MS = 6_000;
/** The chain's hard gate — outside this band neither side can be minted. */
const HARD = 0.005;

d('simple round dead zone (live)', () => {
  it('reports how often a pinned line has stopped being a two-way bet', async () => {
    const client = v2GrpcClient();
    let held: HeldPicks = {};
    let seen = 0;
    let dead = 0;
    let stale = 0;

    for (let i = 0; i < SAMPLES; i++) {
      const now = Date.now();
      const picks = pickAllRounds(activeMarkets(await getV2Markets(100), now), now, held);
      held = {
        '1m': picks['1m']?.expiry_market_id,
        '5m': picks['5m']?.expiry_market_id,
        '1h': picks['1h']?.expiry_market_id,
      };

      const cells: string[] = [];
      for (const c of CADENCE_ORDER) {
        const m = picks[c];
        if (!m) {
          cells.push(`${c}=none`);
          continue;
        }
        const [state, pricer] = await Promise.all([
          getV2MarketState(m.expiry_market_id),
          simulateLivePricer(client, m.expiry_market_id).catch(() => null),
        ]);
        if (!pricer) {
          cells.push(`${c}=nopricer`);
          continue;
        }
        const ref = state?.reference_tick;
        if (ref == null || ref === '') {
          cells.push(`${c}=unpinned`);
          continue;
        }
        const lineScaled = tickToStrike(BigInt(ref), m.tick_size);
        const p = fairUp(pricer, toFloat(lineScaled));
        const secs = Math.round((m.expiry - now) / 1000);
        const isDead = p <= HARD || p >= 1 - HARD;
        const isStale = !lineIsTradeable(pricer, lineScaled);
        seen++;
        if (isDead) dead++;
        if (isStale) stale++;
        cells.push(
          `${c}=${secs}s p=${p.toFixed(4)}${isDead ? ' DEAD' : isStale ? ' stale' : ''}`,
        );
      }
      console.log(`${new Date(now).toISOString().slice(11, 19)}  ${cells.join('  ')}`);
      if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, EVERY_MS));
    }

    console.log(
      `\npinned rounds sampled: ${seen}` +
        `\n  unquotable (both sides refused): ${dead} (${((dead / seen) * 100).toFixed(0)}%)` +
        `\n  past the 5% two-way margin:      ${stale} (${((stale / seen) * 100).toFixed(0)}%)`,
    );
    expect(seen).toBeGreaterThan(0);
  }, 300_000);
});

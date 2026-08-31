/**
 * Live census of the DEAD ZONE, and the proof the fix closes it. Network-gated:
 *
 *   RUN_LIVE=1 npx vitest run lib/sui/v2/simple-round.live.test.ts
 *
 * A trader reported landing on a round with real time left and both sides refusing to
 * quote. That is not a pricing bug: the line is fixed at the round's open, and once spot
 * has walked a few sigma away with the clock running down, UP is worth ~1.00 and DOWN
 * ~0.00, so BOTH fail the mintable gate at the same instant.
 *
 * The census that motivated `chooseRoundLine`, taken 2026-08-21 over 9 samples:
 *
 *   1m=28s p=0.8810   5m=148s p=0.4136   1h=unpinned
 *   1m=20s p=0.9761 stale
 *   1m=11s p=0.9985 DEAD
 *   1m=36s p=1.0000 DEAD   5m=96s p=0.9995 DEAD
 *   1m=26s p=1.0000 DEAD   5m=86s p=1.0000 DEAD
 *
 *   8 of 18 pinned observations unquotable, 9 of 18 past the two-way margin.
 *
 * Note WHERE the dead ones sit: a 1-minute round dead with 36s left and a 5-minute round
 * dead with 96s left. This is not the last-second death rattle, it is one move taking out
 * the rest of the round. Note also that the hourly tab reads `unpinned` throughout — it
 * has no reference tick, so it already re-anchors, which is exactly why it never dies.
 *
 * What this now asserts: whatever line the screen actually OFFERS is a two-way bet.
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets, getV2MarketState } from '@/lib/api/v2/client';
import { activeMarkets } from '@/lib/markets/v2-discovery';
import { pickAllRounds, SIMPLE_CADENCES, type HeldPicks } from '@/lib/markets/round-pick';
import { simulateLivePricer, v2GrpcClient, fairUp } from '@/lib/sui/v2/pricer';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { toFloat, fromFloat } from '@/config/scale';
import { roundLineScaled, chooseRoundLine, quoteSide } from './simple-round';

const RUN = process.env.RUN_LIVE === '1';
const d = RUN ? describe : describe.skip;

const SAMPLES = 16;
const EVERY_MS = 6_000;
/** The chain's hard gate: outside this band neither side can be minted. */
const HARD = 0.005;

d('simple round dead zone (live)', () => {
  it('always offers a line that can still be bet both ways', async () => {
    const client = v2GrpcClient();
    let picksHeld: HeldPicks = {};
    /** The moved-line memory `useRoundQuote` keeps, replayed here across samples. */
    const heldLines = new Map<string, bigint>();
    let seen = 0;
    let pinnedDead = 0;
    let offeredDead = 0;
    let moved = 0;

    for (let i = 0; i < SAMPLES; i++) {
      const now = Date.now();
      let picks;
      try {
        picks = pickAllRounds(activeMarkets(await getV2Markets(100), now), now, picksHeld);
      } catch {
        continue; // a dropped read is a flaky endpoint, not a finding
      }
      picksHeld = {
        '1m': picks['1m']?.expiry_market_id,
        '5m': picks['5m']?.expiry_market_id,
        '1h': picks['1h']?.expiry_market_id,
      };

      const cells: string[] = [];
      for (const c of SIMPLE_CADENCES) {
        const m = picks[c];
        if (!m) {
          cells.push(`${c}=none`);
          continue;
        }
        const [state, pricer] = await Promise.all([
          getV2MarketState(m.expiry_market_id).catch(() => null),
          simulateLivePricer(client, m.expiry_market_id).catch(() => null),
        ]);
        if (!pricer || !state) {
          cells.push(`${c}=unread`);
          continue;
        }
        const ref = state.reference_tick;
        const pinnedScaled =
          ref == null || ref === ''
            ? null
            : roundLineScaled(ref, pricer.forward, m.tick_size, m.admission_tick_size).lineScaled;
        const atm = snapStrikeToAdmission(fromFloat(pricer.forward), m.admission_tick_size);
        const choice = chooseRoundLine(
          pricer,
          atm,
          pinnedScaled,
          heldLines.get(m.expiry_market_id) ?? null,
        );
        if (!choice.pinned) heldLines.set(m.expiry_market_id, choice.lineScaled);

        const secs = Math.round((m.expiry - now) / 1000);
        const pPin = pinnedScaled == null ? null : fairUp(pricer, toFloat(pinnedScaled));
        const up = quoteSide(m, pricer, choice.lineScaled, 100, true);
        const dn = quoteSide(m, pricer, choice.lineScaled, 100, false);

        seen++;
        if (pPin != null && (pPin <= HARD || pPin >= 1 - HARD)) pinnedDead++;
        if (choice.moved) moved++;
        if (!up.quotable || !dn.quotable) offeredDead++;

        cells.push(
          `${c}=${secs}s pin=${pPin == null ? 'none' : pPin.toFixed(4)}` +
            ` offer=${up.entryProb.toFixed(4)}${choice.moved ? ' MOVED' : ''}` +
            `${up.quotable && dn.quotable ? '' : ' DEAD'}`,
        );

        // THE invariant: whatever we put in front of a trader must be bettable both ways.
        expect(up.quotable, `${c} UP unquotable at ${secs}s`).toBe(true);
        expect(dn.quotable, `${c} DOWN unquotable at ${secs}s`).toBe(true);
      }
      console.log(`${new Date(now).toISOString().slice(11, 19)}  ${cells.join('  ')}`);
      if (i < SAMPLES - 1) await new Promise((r) => setTimeout(r, EVERY_MS));
    }

    console.log(
      `\nrounds sampled: ${seen}` +
        `\n  pinned line unquotable:  ${pinnedDead}` +
        `\n  line moved to the money: ${moved}` +
        `\n  offered line unquotable: ${offeredDead}  <- must be 0`,
    );
    expect(seen).toBeGreaterThan(0);
    expect(offeredDead).toBe(0);
  }, 300_000);
});

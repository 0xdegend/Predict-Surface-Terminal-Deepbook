/**
 * Live: the chain quote for a real market, next to the client estimate for the same bet.
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 npx vitest run lib/sui/v2/quote-mint.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { v2ReadClient } from '@/lib/sui/grpc-core';
import { readWrapper } from './account';
import { simulateLivePricer } from './pricer';
import { planBinaryBudgetMint, planRangeBudgetMint } from './budget-mint';
import { pickRange } from '@/lib/copilot/range-pick';
import { quoteBudgetMint } from './quote-mint';
import { onchainMarkets, onchainPythLatest } from '@/lib/api/v2/onchain';
import { hasTimeToTrade } from '@/lib/autopilot/policy';

const RUN = process.env.RUN_LIVE === '1';
/** Any wallet with an account on the active deployment; the deployer always has one. */
const OWNER = process.env.QUOTE_OWNER ?? '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4';

describe.skipIf(!RUN)('chain quote by simulate (live)', () => {
  it('prices a real bet, and sits within reach of the client estimate for it', async () => {
    const client = v2ReadClient();
    const { wrapperId, exists } = await readWrapper(client.core, OWNER);
    expect(exists).toBe(true);
    const now = Date.now();
    const markets = (await onchainMarkets(60)).filter((m) => hasTimeToTrade(m.expiry, now)).sort((a, b) => a.expiry - b.expiry).slice(0, 3);
    expect(markets.length).toBeGreaterThan(0);
    const obs = (await onchainPythLatest()) as unknown as Record<string, unknown>;
    const spot = Number(obs.price_magnitude) * 10 ** -Number(obs.exponent_magnitude);
    console.log(`\n  spot ${spot.toFixed(2)}`);
    let priced = 0;
    for (const m of markets) {
      const pricer = await simulateLivePricer(client.core, m.expiry_market_id);
      const plan = planBinaryBudgetMint({ market: m, forward: pricer.forward, svi: pricer.svi, strikePrice: Math.round(spot * 0.999), isUp: true, stake: 5, leverage: 1 });
      const q = await quoteBudgetMint(client.core, { owner: OWNER, wrapperId, marketId: m.expiry_market_id, lowerTick: plan.mint.lowerTick, higherTick: plan.mint.higherTick, amount: plan.mint.amount, leverage: plan.mint.leverage });
      if (!q) {
        // 8-21 refuses strikes outside a per-market probability policy; a 0.1% strike on
        // a market about to settle can sit outside it. The engine holds on that, so here
        // it is a skip, not a failure, as long as some market priced.
        console.log(`  ${((m.expiry - now) / 60000).toFixed(1).padStart(6)} min left  UP ${plan.strike}  client ${plan.entryProb.toFixed(3)}  chain refused`);
        continue;
      }
      priced++;
      expect(q.entryProb).toBeGreaterThan(0);
      expect(q.entryProb).toBeLessThan(1);
      expect(q.quantityBase).toBeGreaterThan(0n);
      const gap = q.entryProb - plan.entryProb;
      console.log(`  ${((m.expiry - now) / 60000).toFixed(1).padStart(6)} min left  UP ${plan.strike}  client ${plan.entryProb.toFixed(3)}  chain ${q.entryProb.toFixed(3)}  gap ${(gap >= 0 ? '+' : '') + gap.toFixed(3)}  qty client ${plan.quantity} chain ${q.quantityBase}`);
      expect(Math.abs(gap)).toBeLessThan(0.35);
    }
    expect(priced).toBeGreaterThan(0);
  }, 120_000);

  it("prices Kelly's range pick too: a band the chain accepts, near the client estimate", async () => {
    const client = v2ReadClient();
    const { wrapperId, exists } = await readWrapper(client.core, OWNER);
    expect(exists).toBe(true);
    const now = Date.now();
    const markets = (await onchainMarkets(60)).filter((m) => hasTimeToTrade(m.expiry, now)).sort((a, b) => a.expiry - b.expiry).slice(0, 3);
    expect(markets.length).toBeGreaterThan(0);
    let priced = 0;
    for (const m of markets) {
      const pricer = await simulateLivePricer(client.core, m.expiry_market_id);
      // No tape here, so this is the plain band at the safe width, the same one
      // Autopilot falls back to when nothing is mispriced.
      const pick = pickRange({ market: m, pricer }, { closes: null, spot: null, now });
      if (!pick) {
        console.log(`  ${((m.expiry - now) / 60000).toFixed(1).padStart(6)} min left  no range on offer (grid too coarse for the band)`);
        continue;
      }
      const plan = planRangeBudgetMint({ market: m, forward: pricer.forward, svi: pricer.svi, lower: pick.lower, higher: pick.higher, stake: 5, leverage: 1 });
      const q = await quoteBudgetMint(client.core, { owner: OWNER, wrapperId, marketId: m.expiry_market_id, lowerTick: plan.mint.lowerTick, higherTick: plan.mint.higherTick, amount: plan.mint.amount, leverage: plan.mint.leverage });
      const gap = q ? q.entryProb - plan.entryProb : NaN;
      console.log(`  ${((m.expiry - now) / 60000).toFixed(1).padStart(6)} min left  RANGE ${plan.lower}-${plan.higher}  client ${plan.entryProb.toFixed(3)}  chain ${q ? q.entryProb.toFixed(3) : 'refused'}  gap ${Number.isFinite(gap) ? (gap >= 0 ? '+' : '') + gap.toFixed(3) : '-'}`);
      if (!q) continue; // the per-market probability policy can refuse a band; the engine holds on that
      priced++;
      expect(q.entryProb).toBeGreaterThan(0);
      expect(q.entryProb).toBeLessThan(1);
      expect(q.quantityBase).toBeGreaterThan(0n);
      expect(Math.abs(gap)).toBeLessThan(0.35);
    }
    expect(priced).toBeGreaterThan(0);
  }, 120_000);
});

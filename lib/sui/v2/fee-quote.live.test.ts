/**
 * Does the SDK's local cost arithmetic actually match what the chain charges?
 *
 * The whole point of moving the display onto `@mysten/deepbook-v3` is that our own model
 * was wrong by 2x and we could not see it. Swapping one unverified model for another would
 * be the same mistake with a nicer import, so this prices a bet BOTH ways against live
 * markets and asserts they agree to the cent: locally via `localBudgetCost`, and on chain
 * by simulating the real mint and reading its `OrderMinted`.
 *
 *   RUN_LIVE=1 NEXT_PUBLIC_SUI_NETWORK=mainnet npx vitest run lib/sui/v2/fee-quote.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { v2ReadClient } from '@/lib/sui/grpc-core';
import { readWrapper } from '@/lib/sui/v2/account';
import { simulateLivePricer } from '@/lib/sui/v2/pricer';
import { planBinaryBudgetMint } from '@/lib/sui/v2/budget-mint';
import { buildMintBudgetTx } from '@/lib/sui/v2/predict-tx';
import { parseMintQuote } from '@/lib/sui/v2/quote-mint';
import { localQuantityCost } from './fee-quote';
import { onchainMarkets, onchainPythLatest } from '@/lib/api/v2/onchain';
import { predictV2Config } from '@/config/predict';

const RUN = process.env.RUN_LIVE === '1';
const OWNER = process.env.QUOTE_OWNER ?? '0x06a6f0f02ee7883cc37dfc0fd72834559cf008dde1cd7f2ee86e4a65688cfa48';
const raw = (p: number) => BigInt(Math.round(p * 1e9));

describe.runIf(RUN)('fee-quote vs the chain', () => {
  it('prices a budget mint the same as the chain does', async () => {
    const client = v2ReadClient();
    const { wrapperId } = await readWrapper(client.core, OWNER);
    const now = Date.now();
    const markets = (await onchainMarkets(60))
      .filter((m) => m.expiry > now + 90_000)
      .sort((a, b) => a.expiry - b.expiry)
      .slice(0, 2);
    const obs = (await onchainPythLatest()) as unknown as Record<string, unknown>;
    const spot = Number(obs.price_magnitude) * 10 ** -Number(obs.exponent_magnitude);
    let compared = 0;

    for (const m of markets) {
      const pricer = await simulateLivePricer(client.core, m.expiry_market_id);
      for (const mult of [0.9995, 1.0005, 1.002]) {
        const strike = Math.round(spot * mult);
        const plan = planBinaryBudgetMint({ market: m, forward: pricer.forward, svi: pricer.svi, strikePrice: strike, isUp: true, stake: 1.7, leverage: 1 });
        if (!plan.probOk) continue;

        const tx = buildMintBudgetTx({ marketId: m.expiry_market_id, wrapperId: wrapperId!, lowerTick: plan.mint.lowerTick, higherTick: plan.mint.higherTick, amount: plan.mint.amount, minQuantity: 0n, leverage: plan.mint.leverage });
        tx.setSender(OWNER);
        const res = await (client.core as never as { simulateTransaction: (o: unknown) => Promise<unknown> })
          .simulateTransaction({ transaction: tx, include: { events: true }, checksEnabled: false });
        const chain = parseMintQuote(res);
        if (!chain) continue;

        // Feed the SDK the CHAIN's own probability and quantity. That isolates the thing
        // we are adopting, the fee arithmetic, from our float pricer's drift against the
        // chain's fixed point, which is a separate pre-existing gap and is NOT what this
        // change is fixing. An UP binary is the range [strike, +inf): a finite lower leg
        // whose probability IS the entry probability, and an infinite higher leg.
        const local = localQuantityCost({
          market: m,
          lowerUp: raw(chain.entryProb),
          higherUp: null,
          builderCode: !!predictV2Config.builderCodeId,
          quantityBase: chain.quantityBase,
        });
        expect(local, 'the SDK refused a mint the chain accepted').not.toBeNull();
        compared++;

        const cents = (b: bigint) => Number(b) / 1e6;
        const chainFee = chain.tradingFeeBase - chain.feeSubsidyBase;
        console.log(
          `p=${chain.entryProb.toFixed(4)} qty ${cents(chain.quantityBase).toFixed(2)}` +
            `  tradingFee local ${local!.protocolFee.toFixed(6)} / chain ${cents(chainFee).toFixed(6)}` +
            `  builder local ${local!.builderFee.toFixed(6)} / chain ${cents(chain.builderFeeBase).toFixed(6)}` +
            `  ALL-IN local ${local!.cost.toFixed(6)} / chain ${cents(chain.totalCostBase).toFixed(6)}` +
            `   | our OLD flat estimate would have said ${(0.204 * cents(chain.quantityBase)).toFixed(6)}`,
        );

        // Same inputs, same integers. These are exact ports, so demand near-exact equality
        // rather than a tolerance that could hide a second wrong model.
        expect(local!.raw.tradingFee).toBe(chainFee);
        expect(local!.raw.builderFee).toBe(chain.builderFeeBase);
        expect(local!.raw.cost).toBe(chain.totalCostBase);
      }
    }
    expect(compared, 'no market priced, cannot conclude anything').toBeGreaterThan(0);
  }, 300_000);
});

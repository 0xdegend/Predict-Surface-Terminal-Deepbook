/**
 * The starter grant, simulated end to end. SIGNS NOTHING.
 *
 * The grant sends `predictV2Config.quote.coinType` from the treasury to a new wallet, so a
 * deployment that publishes its OWN collateral silently re-points this at a coin the
 * treasury may not hold. Nothing in the route would catch that before a real trader clicked
 * the button: `coinWithBalance` resolves at build time and the failure surfaces as a 502.
 *
 * 9-12 is exactly that case (`dusdc::DUSDC` became `usdc::USDC`, a fresh currency with a
 * fresh supply and no swap from the old one), so this builds the route's real transaction
 * and dry-runs it. A pass means the treasury holds the right coin, in enough size, and the
 * PTB shape is accepted by the chain.
 */
import { describe, it, expect } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction, coinWithBalance } from '@mysten/sui/transactions';
import { predictConfig, predictV2Config, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { STARTER_GRANT_BASE_DEFAULT } from '@/config/starter-grant';

const RUN = process.env.RUN_LIVE === '1' && !!process.env.STARTER_GRANT_PRIVATE_KEY;
const SUI = '0x2::sui::SUI';
/** A throwaway recipient: the simulation never executes, so nothing lands here. */
const RECIPIENT = '0x000000000000000000000000000000000000000000000000000000000000dead';

describe.skipIf(!RUN)(`starter grant on ${ACTIVE_V2_DEPLOYMENT}`, () => {
  it('the treasury holds the active collateral and the transfer simulates clean', async () => {
    const signer = Ed25519Keypair.fromSecretKey(process.env.STARTER_GRANT_PRIVATE_KEY!);
    const treasury = signer.getPublicKey().toSuiAddress();
    // The exact client the route builds, so this tests the endpoint the grant will use.
    const client = new SuiGrpcClient({
      network: predictConfig.network,
      baseUrl: process.env.STARTER_GRANT_RPC_URL || predictConfig.grpcUrl,
    });
    const grant = BigInt(process.env.STARTER_GRANT_BASE ?? STARTER_GRANT_BASE_DEFAULT);
    const quote = predictV2Config.quote.coinType;

    const bal = async (coinType: string) =>
      BigInt((await client.core.getBalance({ owner: treasury, coinType })).balance?.balance ?? 0);
    const held = await bal(quote);
    const sui = await bal(SUI);
    const each = Number(grant) / 10 ** predictV2Config.quote.decimals;
    console.log(`\n  treasury   ${treasury}`);
    console.log(`  collateral ${quote.split('::').slice(1).join('::')}`);
    console.log(`  holds      ${(Number(held) / 10 ** predictV2Config.quote.decimals).toLocaleString()} ${predictV2Config.quote.symbol}`);
    console.log(`  grant size ${each} ${predictV2Config.quote.symbol} → funds ${Math.floor(Number(held) / Number(grant))} new wallets`);
    console.log(`  gas        ${(Number(sui) / 1e9).toFixed(3)} SUI`);

    expect(
      held,
      `treasury holds no ${predictV2Config.quote.symbol} for ${ACTIVE_V2_DEPLOYMENT} (${quote}). ` +
        `Every grant will 502 until it is funded with THIS coin; the previous deployment's balance cannot be swapped.`,
    ).toBeGreaterThanOrEqual(grant);

    // The route's transaction, byte for byte, including the SUI drip an external wallet gets.
    const tx = new Transaction();
    tx.setSender(treasury);
    const coin = tx.add(coinWithBalance({ type: quote, balance: grant }));
    const [drip] = tx.splitCoins(tx.gas, [BigInt(process.env.STARTER_GRANT_SUI_BASE ?? 50_000_000n)]);
    tx.transferObjects([coin, drip], tx.pure.address(RECIPIENT));

    const res = (await client.core.simulateTransaction({ transaction: tx })) as {
      $kind?: string;
      FailedTransaction?: { status?: { error?: unknown } };
      Transaction?: { effects?: { status?: unknown } };
    };
    const failure = res.$kind === 'FailedTransaction' ? res.FailedTransaction : undefined;
    expect(
      failure,
      `the grant transfer would abort: ${JSON.stringify(failure?.status?.error ?? {}).slice(0, 300)}`,
    ).toBeUndefined();
    console.log(`  dry run    clean, signs nothing\n`);
  }, 120_000);
});

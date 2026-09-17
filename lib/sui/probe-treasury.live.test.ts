/** TEMPORARY, READ ONLY: does the grant treasury hold the 9-12 collateral + gas? */
import { describe, it } from 'vitest';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, predictConfigFor } from '@/config/predict';

const RUN = process.env.RUN_LIVE === '1' && process.env.PROBE === '1';

describe.skipIf(!RUN)('starter-grant treasury', () => {
  it('reports balances', async () => {
    const kp = Ed25519Keypair.fromSecretKey(process.env.STARTER_GRANT_PRIVATE_KEY!);
    const addr = kp.getPublicKey().toSuiAddress();
    const client = new SuiGrpcClient({ network: 'testnet', baseUrl: process.env.NEXT_PUBLIC_SUI_GRPC_URL! });
    console.log(`\n  treasury ${addr}`);
    const show = async (label: string, coinType: string, dec: number) => {
      const r = await client.core.getBalance({ owner: addr, coinType }).catch((e) => { console.log(`  ${label} ERR ${String(e).slice(0,90)}`); return null; });
      if (!r) return;
      const bal = BigInt(r.balance?.balance ?? 0);
      console.log(`  ${label.padEnd(16)} ${(Number(bal) / 10 ** dec).toLocaleString()}  (${bal} base)`);
    };
    await show('USDC (9-12)', predictV2Config.quote.coinType, predictV2Config.quote.decimals);
    await show('old DUSDC', predictConfigFor('8-21').quote.coinType, 6);
    await show('SUI', '0x2::sui::SUI', 9);
  }, 120_000);
});

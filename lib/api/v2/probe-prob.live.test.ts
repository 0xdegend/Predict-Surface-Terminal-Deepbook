/** TEMPORARY: what does 9-12's strike_exposure_config expose and enforce? */
import { describe, it } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config } from '@/config/predict';

const RUN = process.env.RUN_LIVE === '1' && process.env.PROBE === '1';

describe.skipIf(!RUN)('9-12 strike_exposure_config', () => {
  it('lists its functions and constants', async () => {
    const client = new SuiGrpcClient({ network: 'testnet', baseUrl: predictV2Config.grpcUrl });
    const res = (await client.movePackageService.getPackage({ packageId: predictV2Config.packages.predict })) as {
      response?: { package?: { modules?: { name?: string; functions?: { name?: string; parameters?: unknown[]; returns?: unknown[] }[] }[] } };
    };
    const mods = res.response?.package?.modules ?? [];
    const m = mods.find((x) => x.name === 'strike_exposure_config');
    console.log(`\n  package has ${mods.length} modules`);
    if (!m) { console.log('  no strike_exposure_config module'); return; }
    const fns = (m.functions ?? []).map((f) => `${f.name}(${(f.parameters ?? []).length})→${(f.returns ?? []).length}`);
    console.log(`  strike_exposure_config: ${fns.length} functions`);
    for (const f of fns.sort()) console.log(`    ${f}`);
    const prob = (m.functions ?? []).filter((f) => /prob/i.test(f.name ?? ''));
    console.log(`\n  probability-related: ${prob.map((f) => f.name).join(', ') || '(none)'}`);
  }, 180_000);
});

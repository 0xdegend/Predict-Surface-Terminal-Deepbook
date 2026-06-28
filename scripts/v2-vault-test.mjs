// Phase 3 validation: simulate the PLP vault view functions and decode them.
// Read-only — proves the vault-state read spine. Run: node scripts/v2-vault-test.mjs
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

const GRPC = 'https://fullnode.testnet.sui.io:443';
const PKG = '0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e';
const VAULT = '0xfde98c636eb8a7aba59c3a238cfee6b576b7118d1e5ffa2952876c4b270a3a2a';
const SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';
const VIEWS = ['idle_balance', 'plp_total_supply', 'supply_requests_pending', 'withdraw_requests_pending', 'protocol_reserve_balance', 'fee_incentive_reserve', 'staked_deep'];

const main = async () => {
  const tx = new Transaction();
  tx.setSender(SENDER);
  for (const fn of VIEWS) tx.moveCall({ target: `${PKG}::plp::${fn}`, arguments: [tx.object(VAULT)] });
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC });
  const res = await client.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
  if (res.$kind === 'FailedTransaction') throw new Error('simulate failed: ' + JSON.stringify(res.FailedTransaction?.status));
  const cmds = res.commandResults ?? [];
  VIEWS.forEach((fn, i) => {
    const v = BigInt(bcs.u64().parse(new Uint8Array(cmds[i].returnValues[0].bcs)));
    const dusdc = fn.includes('pending') || fn.includes('deep') ? String(v) : `$${(Number(v) / 1e6).toLocaleString()}`;
    console.log(`  ${fn.padEnd(26)} ${dusdc}`);
  });
  console.log('\nOK — v2 vault state read validated against live chain.');
};
main().catch((e) => { console.error(e); process.exit(1); });

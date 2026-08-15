// Walrus Memory (MemWal) Phase 1 proof: remember a fact signed by our registered delegate
// key, then recall it by semantic query and assert the fact comes back. Exercises the real
// path (delegate auth -> relayer embeds + Seal-encrypts + uploads to Walrus + indexes).
// Needs WALRUS_DELEGATE_KEY (registered delegate) + WALRUS_MEMORY_ACCOUNT_ID in .env.
//
// Run: node --env-file=.env scripts/walrus-memory-roundtrip.mjs
import { MemWal } from '@mysten-incubation/memwal';

const key = process.env.WALRUS_DELEGATE_KEY;
const accountId = process.env.WALRUS_MEMORY_ACCOUNT_ID;
if (!key || !accountId) {
  console.error('Need WALRUS_DELEGATE_KEY + WALRUS_MEMORY_ACCOUNT_ID in .env');
  process.exit(1);
}

const RELAYER = 'https://relayer-staging.memory.walrus.xyz'; // testnet staging
const NS = 'kelly';

const memwal = MemWal.create({ key, accountId, serverUrl: RELAYER, namespace: NS });
console.log('account   :', accountId);
console.log('relayer   :', RELAYER, '| namespace:', NS);

const nonce = Date.now();
const fact = `Skew Phase 1 proof ${nonce}. This trader prefers safer UP bets near the money and avoids 1-hour leverage.`;

console.log('\nremembering:', fact);
const r = await memwal.rememberAndWait(fact, NS, { timeoutMs: 150_000 });
console.log('stored     : id=', r.id, '| blob_id=', r.blob_id);

// The vector index can lag a beat behind the stored blob; retry the query briefly.
console.log('\nrecalling by semantic query...');
let hit = false;
let lastResults = [];
for (let i = 0; i < 6 && !hit; i++) {
  const res = await memwal.recall({
    query: 'what kind of prediction bets does this trader like?',
    namespace: NS,
    limit: 5,
  });
  lastResults = res.results ?? [];
  hit = lastResults.some((m) => (m.text ?? '').includes(String(nonce)));
  if (!hit) {
    console.log(`  attempt ${i + 1}: ${res.total ?? 0} results, fact not indexed yet, waiting...`);
    await new Promise((res2) => setTimeout(res2, 4000));
  }
}

console.log('\ntop recalled memories:');
for (const m of lastResults) console.log('  -', (m.text ?? '').slice(0, 110));

console.log(`\nMEMORY ROUND-TRIP: ${hit ? 'MATCH ✓ (recalled the remembered fact)' : 'MISS ✗'}`);
memwal.destroy?.();
process.exit(hit ? 0 : 1);

// Walrus Phase 0 proof: sign a blob WRITE with our dedicated writer key, then READ it
// back and assert byte-equality. Exercises the real production path (SDK writeBlob ->
// storage nodes, signed + paid in WAL), not just the public HTTP publisher. Mirrors the
// calls in lib/walrus/client.ts. Needs WALRUS_WRITER_KEY (a funded testnet key) in .env.
//
// Run: node --env-file=.env scripts/walrus-roundtrip.mjs
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { walrus } from '@mysten/walrus';

const secret = process.env.WALRUS_WRITER_KEY;
if (!secret) {
  console.error('WALRUS_WRITER_KEY not set. Run with: node --env-file=.env scripts/walrus-roundtrip.mjs');
  process.exit(1);
}

const keypair = Ed25519Keypair.fromSecretKey(secret);
const address = keypair.getPublicKey().toSuiAddress();
// Public JSON-RPC is deprecated on Sui testnet fullnodes; the app reads over gRPC. The
// walrus extension derives its network from `client.network`, so it's set on the client.
// Primary Mysten gRPC fullnode (see lib/sui/grpc.ts). Both it and the suiscan peer serve
// getObject, but only the primary answered BatchGetObjects (used by walrus's object loader).
const GRPC = process.env.NEXT_PUBLIC_SUI_GRPC_URL || 'https://fullnode.testnet.sui.io:443';
// Route sliver upload through the relay (one endpoint distributes to storage nodes) instead
// of writing to every node directly, which fails from constrained network environments.
const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC }).$extend(
  walrus({
    uploadRelay: {
      host: 'https://upload-relay.testnet.walrus.space',
      sendTip: { max: 1_000_000 },
    },
  }),
);

const payload = `skew-walrus-phase0 signed ${new Date().toISOString()}`;
console.log('writer address :', address);
console.log('payload        :', payload);

console.log('\nwriting blob (signed, paid in WAL)...');
const { blobId, blobObject } = await client.walrus.writeBlob({
  blob: new TextEncoder().encode(payload),
  epochs: 3,
  deletable: true,
  signer: keypair,
});
console.log('blobId         :', blobId);
console.log('blob object id :', blobObject.id);
console.log('expires epoch  :', blobObject.storage.end_epoch);

// Read back via the HTTP aggregator (the production read path — see lib/walrus/client.ts).
// The SDK's direct storage-node read is blocked in constrained environments, same as a
// direct write. Aggregators can briefly 404 a just-certified blob; retry with backoff.
const AGGREGATOR = 'https://aggregator.walrus-testnet.walrus.space';
console.log('\nreading blob back (via aggregator)...');
// A freshly certified blob can take ~30-60s to become readable via the aggregator CDN
// (it negative-caches the 404 briefly), so give it up to ~2 min.
let text = null;
for (let i = 0; i < 24; i++) {
  try {
    const res = await fetch(`${AGGREGATOR}/v1/blobs/${blobId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
    break;
  } catch (e) {
    console.log(`  read retry ${i + 1}: ${e?.message ?? e}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
}
console.log('read back      :', text);

const ok = text === payload;
console.log(`\nROUND-TRIP: ${ok ? 'MATCH ✓' : 'MISMATCH ✗'}`);
process.exit(ok ? 0 : 1);

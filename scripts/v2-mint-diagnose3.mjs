// Fully-funded atomic diagnostic: one simulated tx that (1) deposits the user's
// own DUSDC, (2) loads the pricer, (3) mints with wide-open guards. On success,
// the same-tx pricer (command result) gives the client-side fair and the
// OrderMinted event gives the CHAIN's entry_probability — same instant, zero
// drift. Run: node scripts/v2-mint-diagnose3.mjs
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

const GRPC = 'https://fullnode.testnet.sui.io:443';
const BETA = 'https://predict-server-beta.testnet.mystenlabs.com';
const PKG = '0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e';
const ACCOUNT_PKG = '0xb9389eac8d59170ffd1427c1a66e5c8306263464fcc6615e825c1f5b3e15da3b';
const DUSDC = '0xe95040085976bfd54a1a07225cd46c8a2b4e8e2b6732f140a0fc49850ba73e1a::dusdc::DUSDC';
const PROTOCOL_CONFIG = '0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6';
const ORACLE_REGISTRY = '0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136';
const PYTH = '0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb';
const BS_SPOT = '0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745';
const BS_FORWARD = '0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a';
const BS_SVI = '0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69';
const CLOCK = '0x6';
const ACC_ROOT = '0x0000000000000000000000000000000000000000000000000000000000000acc';
const SENDER = '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4';
const WRAPPER = '0x6b789de1c2e8e34d315268367f70f7a05a4625043a1310f1c858fb795a7e7eac';
const POS_INF_TICK = 1_073_741_823n;
const QTY = 2_120_000n;
const COINS = [
  '0x24d90f59faf763d40729917684dbe00dd94689f952453ee9ddd46158d5ffb9b4',
  '0x95e058e98de867c944e44381083d870e4a89010639e2692b68f88234f3226dec',
  '0x9ea5c78946c9e3a1009829ddfc7a91683bf0da4bc03770d4bc86a74b7836f943',
  '0xeadb13b346795a6048166cb6722029a93387aef4eb9ed89fe295f802e5f7f798',
  '0x31363ddfc8496a0c45b608715ee7fe71098c6b20a8f5d7fb60de0add8acd4f7d',
  '0x17ede9b0210d8a1f8e749da9874703c20cb3dcb8fc88b13bc3fec8c53f05e7d9',
  '0x39bc130404e42d311976f9a6a251c06f2fe44e82b00a23034f346cf26ca05ed9',
  '0x9a1568f70006b64cedac70879b8704cbece41230a45ddd213ac7222e573f97f5',
  '0x8b732ca456c7fe70b99adbc1e379f6dff2c45d27e193aa812db7ca8476dc54a0',
  '0x4221db85e52987b23af5bb9aa10f2f7e95db218fec504cbb3079623804306822',
];

const I64 = bcs.struct('I64', { magnitude: bcs.u64(), is_negative: bcs.bool() });
const SVIParams = bcs.struct('SVIParams', { a: bcs.u64(), b: bcs.u64(), rho: I64, m: I64, sigma: bcs.u64() });
const Pricer = bcs.struct('Pricer', { expiry_market_id: bcs.Address, forward: bcs.u64(), svi: SVIParams });
const f9 = (v) => Number(v) / 1e9;
const signed = (x) => (x.is_negative ? -1 : 1) * f9(x.magnitude);
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  const p = d * t * (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  return x >= 0 ? 1 - p : p;
}
function upFair(strike, forward, svi) {
  const k = Math.log(strike / forward);
  const w = svi.a + svi.b * (svi.rho * (k - svi.m) + Math.sqrt((k - svi.m) ** 2 + svi.sigma ** 2));
  return normalCdf(-((k + w / 2) / Math.sqrt(w)));
}

const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC });
const j = async (p) => (await fetch(`${BETA}${p}`)).json();

const now = Date.now();
const markets = (await j('/markets')).filter((m) => Number(m.expiry) > now + 120_000);
markets.sort((a, b) => Number(b.expiry) - Number(a.expiry));
const live = markets[0]; // longest expiry = 1h cadence, largest backing
console.log(`market ${live.expiry_market_id.slice(0, 10)}… expires in ${((Number(live.expiry) - now) / 60000).toFixed(1)} min`);

// Quick pricer-only sim to pick an admission-aligned ATM strike.
{
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: `${PKG}::expiry_market::load_live_pricer`,
    arguments: [
      tx.object(live.expiry_market_id), tx.object(PROTOCOL_CONFIG), tx.object(ORACLE_REGISTRY),
      tx.object(PYTH), tx.object(BS_SPOT), tx.object(BS_FORWARD), tx.object(BS_SVI), tx.object(CLOCK),
    ],
  });
  const res = await client.core.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
  const p = Pricer.parse(new Uint8Array(res.commandResults[0].returnValues[0].bcs));
  globalThis.__atm = Math.round(f9(p.forward) / f9(live.admission_tick_size)) * f9(live.admission_tick_size);
  const preSvi = { a: f9(p.svi.a), b: f9(p.svi.b), rho: signed(p.svi.rho), m: signed(p.svi.m), sigma: f9(p.svi.sigma) };
  globalThis.__preFair = upFair(globalThis.__atm, f9(p.forward), preSvi);
  console.log(`pre-scan forward $${f9(p.forward).toFixed(2)} → ATM strike $${globalThis.__atm}, fair ${(globalThis.__preFair*100).toFixed(3)}%`);
}
const atmTick = BigInt(Math.round(globalThis.__atm / f9(live.tick_size)));
// Optional tight probability guard: MAXPROB_FRAC × (pre-scan client fair).
const frac = process.env.MAXPROB_FRAC ? Number(process.env.MAXPROB_FRAC) : null;
const maxProbArg = frac ? BigInt(Math.round(globalThis.__preFair * frac * 1e9)) : 1_000_000_000n;
if (frac) console.log(`maxProbability = pre-scan fair × ${frac} = ${(Number(maxProbArg)/1e7).toFixed(3)}%`);

// The funded, wide-open, atomic mint.
const tx = new Transaction();
tx.setSender(SENDER);
const merged = tx.object(COINS[0]);
tx.mergeCoins(merged, COINS.slice(1).map((c) => tx.object(c)));
const [dep] = tx.splitCoins(merged, [tx.pure.u64(2_000_000n)]); // $2 deposit
const auth1 = tx.moveCall({ target: `${ACCOUNT_PKG}::account::generate_auth`, arguments: [] });
tx.moveCall({
  target: `${ACCOUNT_PKG}::account::deposit_funds`,
  typeArguments: [DUSDC],
  arguments: [tx.object(WRAPPER), auth1, dep, tx.object(ACC_ROOT), tx.object(CLOCK)],
});
const pricerRes = tx.moveCall({
  target: `${PKG}::expiry_market::load_live_pricer`,
  arguments: [
    tx.object(live.expiry_market_id), tx.object(PROTOCOL_CONFIG), tx.object(ORACLE_REGISTRY),
    tx.object(PYTH), tx.object(BS_SPOT), tx.object(BS_FORWARD), tx.object(BS_SVI), tx.object(CLOCK),
  ],
});
const auth2 = tx.moveCall({ target: `${ACCOUNT_PKG}::account::generate_auth`, arguments: [] });
if (process.env.BUDGET) {
  const amount = 1_010_000n; // $1.01 — the $1 min plus one cent of lot headroom
  const minQty = BigInt(Math.floor((Number(amount) / (globalThis.__preFair * 1.05)) / 10_000)) * 10_000n;
  console.log(`mint_exact_amount: amount $${Number(amount)/1e6}, min_quantity ${minQty} (5% odds slack)`);
  tx.moveCall({
    target: `${PKG}::expiry_market::mint_exact_amount`,
    arguments: [
      tx.object(live.expiry_market_id), tx.object(WRAPPER), auth2, tx.object(PROTOCOL_CONFIG), pricerRes,
      tx.pure.u64(atmTick), tx.pure.u64(POS_INF_TICK),
      tx.pure.u64(amount), tx.pure.u64(minQty), tx.pure.u64(1_000_000_000n),
      tx.object(ACC_ROOT), tx.object(CLOCK),
    ],
  });
} else {
  tx.moveCall({
    target: `${PKG}::expiry_market::mint_exact_quantity`,
    arguments: [
      tx.object(live.expiry_market_id), tx.object(WRAPPER), auth2, tx.object(PROTOCOL_CONFIG), pricerRes,
      tx.pure.u64(atmTick), tx.pure.u64(POS_INF_TICK), tx.pure.u64(QTY),
      tx.pure.u64(1_000_000_000n),
      tx.pure.u64(18_446_744_073_709_551_615n),
      tx.pure.u64(maxProbArg),
      tx.object(ACC_ROOT), tx.object(CLOCK),
    ],
  });
}

const res = await client.core.simulateTransaction({ transaction: tx, include: { commandResults: true }, checksEnabled: false });
if (res.$kind === 'FailedTransaction') {
  console.log('FAILED:', JSON.stringify(res.FailedTransaction?.status?.error ?? res).slice(0, 400));
  process.exit(1);
}

// Same-tx client fair from the pricer command (index 4: merge=0,split=1,auth=2,deposit=3,pricer=4).
const pr = res.commandResults?.find((c) => c?.returnValues?.length && c.returnValues[0].bcs?.length > 60);
const p = Pricer.parse(new Uint8Array(pr.returnValues[0].bcs));
const svi = { a: f9(p.svi.a), b: f9(p.svi.b), rho: signed(p.svi.rho), m: signed(p.svi.m), sigma: f9(p.svi.sigma) };
const clientFair = upFair(globalThis.__atm, f9(p.forward), svi);
console.log(`same-tx pricer: forward $${f9(p.forward).toFixed(2)}, client fair UP @ $${globalThis.__atm} = ${(clientFair * 100).toFixed(3)}%`);

// Chain's own numbers from the OrderMinted event.
const events = res.transaction?.events?.events ?? res.events?.events ?? res.transaction?.events ?? [];
const list = Array.isArray(events) ? events : [];
console.log(`events: ${list.length}`);
for (const ev of list) {
  const type = ev.eventType ?? ev.type ?? '';
  if (!/OrderMinted|order_events/i.test(type)) continue;
  console.log('OrderMinted event:', JSON.stringify(ev.json ?? ev.parsedJson ?? ev.contents ?? ev).slice(0, 900));
}

// Phase 1 (v2) validation: simulate expiry_market::load_live_pricer against the
// NEW deployment, decode the returned Pricer { expiry_market_id, forward, svi },
// and compute client-side fair UP prices across the strike grid. Read-only — proves
// the v2 quote spine without a wallet. Run: node scripts/v2-quote-test.mjs
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

const BETA = 'https://predict-server-beta.testnet.mystenlabs.com';
const GRPC = 'https://fullnode.testnet.sui.io:443';

// v2 testnet ids (mirror config/predict.ts V2_TESTNET).
const PKG = '0xdb3ef5a5129920e59c9b2ae25a77eddb48acd0e1c6307b97073f0e076016446e';
const PROTOCOL_CONFIG = '0x2325224629b4bd96d1f1d7ee937e07f8a06f861018a130bbb26db09cb0394cb6';
const ORACLE_REGISTRY = '0xf3deaff68cbd081a35ec21653af6f671d2ad5f012f3b4d817d81752843374136';
const PYTH = '0xc78d7de16217d46d21b92ae475da799448be30b71a758dc6d7bb3ac2f1c35afb';
const BS_SPOT = '0xcdc5fa7364e60fd2504aa96f65b707dc0734e507a919b1a7d7d63164fd67b745';
const BS_FORWARD = '0xe72c734ea8d8dcbc9183d9d8f96f51aaa1fb5034d5ed33ac60d67d261e15b48a';
const BS_SVI = '0xdc2f8270676bd05fb28491e8d4a41a495722fda7a454926dd66dbba256a21c69';
const CLOCK = '0x6';
const SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

// Pricer BCS layout (verified from pricing.move + block_scholes_svi_feed.move).
const I64 = bcs.struct('I64', { magnitude: bcs.u64(), is_negative: bcs.bool() });
const SVIParams = bcs.struct('SVIParams', {
  a: bcs.u64(), b: bcs.u64(), rho: I64, m: I64, sigma: bcs.u64(),
});
const Pricer = bcs.struct('Pricer', {
  expiry_market_id: bcs.Address, forward: bcs.u64(), svi: SVIParams,
});

const j = async (p) => (await fetch(`${BETA}${p}`)).json();
const f9 = (v) => Number(v) / 1e9;
const signed = (x) => (x.is_negative ? -1 : 1) * f9(x.magnitude);

// Standard normal CDF (Abramowitz & Stegun 7.1.26) — mirrors lib/svi/normal.ts.
function normalCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const d = 0.3989422804014327 * Math.exp(-(x * x) / 2);
  let p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  p = x >= 0 ? 1 - p : p;
  return p;
}
function upFair(strike, forward, svi) {
  const k = Math.log(strike / forward);
  const km = k - svi.m;
  const w = svi.a + svi.b * (svi.rho * km + Math.sqrt(km * km + svi.sigma * svi.sigma));
  if (w <= 0) return k < 0 ? 1 : 0;
  return normalCdf(-((k + w / 2) / Math.sqrt(w)));
}

async function loadPricer(client, marketId) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  tx.moveCall({
    target: `${PKG}::expiry_market::load_live_pricer`,
    arguments: [
      tx.object(marketId), tx.object(PROTOCOL_CONFIG), tx.object(ORACLE_REGISTRY),
      tx.object(PYTH), tx.object(BS_SPOT), tx.object(BS_FORWARD), tx.object(BS_SVI),
      tx.object(CLOCK),
    ],
  });
  const res = await client.simulateTransaction({
    transaction: tx, include: { commandResults: true }, checksEnabled: false,
  });
  if (res.$kind === 'FailedTransaction') {
    throw new Error('simulate failed: ' + JSON.stringify(res.FailedTransaction?.status ?? res, null, 2));
  }
  const last = (res.commandResults ?? []).at(-1);
  if (!last?.returnValues?.length) throw new Error('no return values (Pricer)');
  return Pricer.parse(new Uint8Array(last.returnValues[0].bcs));
}

const main = async () => {
  const now = Date.now();
  const markets = (await j('/markets?limit=50'))
    .filter((m) => m.expiry > now + 30_000)
    .sort((a, b) => a.expiry - b.expiry);
  if (!markets.length) throw new Error('no active markets');
  const m = markets[markets.length - 1]; // furthest-out, safe from expiry races
  console.log(`market ${m.expiry_market_id.slice(0, 12)}…  expiry ${new Date(m.expiry).toISOString()}  ` +
    `(${Math.round((m.expiry - now) / 1000)}s out)  tick $${f9(m.tick_size)}`);

  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC });
  const p = await loadPricer(client, m.expiry_market_id);
  const forward = f9(p.forward);
  const svi = { a: f9(p.svi.a), b: f9(p.svi.b), rho: signed(p.svi.rho), m: signed(p.svi.m), sigma: f9(p.svi.sigma) };
  console.log(`Pricer decoded ✓  forward $${forward.toFixed(2)}`);
  console.log(`SVI  a=${svi.a.toExponential(3)} b=${svi.b.toExponential(3)} rho=${svi.rho.toFixed(4)} m=${svi.m.toFixed(5)} sigma=${svi.sigma.toFixed(5)}`);

  // Fair UP across a strike window around the forward, snapped to admission ticks.
  const adm = Number(m.admission_tick_size);
  const atm = Math.round((forward * 1e9) / adm) * adm; // 1e9-scaled, on admission grid
  console.log('\n  strike       fair UP    fair DN');
  for (let off = -3; off <= 3; off++) {
    const strikeScaled = atm + off * adm;
    const strike = strikeScaled / 1e9;
    const up = upFair(strike, forward, svi);
    console.log(`  $${strike.toFixed(0).padStart(8)}   ${(up * 100).toFixed(2).padStart(6)}%   ${((1 - up) * 100).toFixed(2).padStart(6)}%`);
  }
  console.log('\nOK — v2 quote spine validated against live chain (simulate load_live_pricer → decode → fair price).');
};

main().catch((e) => { console.error(e); process.exit(1); });

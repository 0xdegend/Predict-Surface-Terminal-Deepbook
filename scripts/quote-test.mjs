// Phase 1 validation: build the SAME market_key::new + get_trade_amounts PTB the
// app builds, simulate it against live testnet, and decode (mint_cost, payout).
// Read-only — proves the quote spine without a wallet. Run: node scripts/quote-test.mjs
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { Transaction } from '@mysten/sui/transactions';
import { bcs } from '@mysten/sui/bcs';

const SERVER = 'https://predict-server.testnet.mystenlabs.com';
const GRPC = 'https://fullnode.testnet.sui.io:443';
const PKG = '0xf5ea2b3749c65d6e56507cc35388719aadb28f9cab873696a2f8687f5c785138';
const PREDICT = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';
const CLOCK = '0x6';
const SENDER = '0x43a5782881f7ae4584fb7a3d9d9b3cd3440ed634a67301de5e45f734505e8e7d';

const j = async (p) => (await fetch(`${SERVER}${p}`)).json();

function snap(strike, min, tick) {
  if (strike <= min) return min;
  const k = (strike - min + tick / 2n) / tick;
  return min + k * tick;
}

async function quote(client, { oracleId, expiry, strike, isUp, quantity }) {
  const tx = new Transaction();
  tx.setSender(SENDER);
  const key = tx.moveCall({
    target: `${PKG}::market_key::new`,
    arguments: [tx.pure.id(oracleId), tx.pure.u64(BigInt(expiry)), tx.pure.u64(strike), tx.pure.bool(isUp)],
  });
  tx.moveCall({
    target: `${PKG}::predict::get_trade_amounts`,
    arguments: [tx.object(PREDICT), tx.object(oracleId), key, tx.pure.u64(quantity), tx.object(CLOCK)],
  });
  const res = await client.simulateTransaction({
    transaction: tx,
    include: { commandResults: true },
    checksEnabled: false,
  });
  if (res.$kind === 'FailedTransaction') {
    throw new Error('simulate failed: ' + JSON.stringify(res.FailedTransaction?.status ?? res, null, 2));
  }
  const cmds = res.commandResults ?? [];
  const last = cmds[cmds.length - 1];
  const cost = BigInt(bcs.u64().parse(last.returnValues[0].bcs));
  const payout = BigInt(bcs.u64().parse(last.returnValues[1].bcs));
  return { cost, payout };
}

const main = async () => {
  const oracles = (await j(`/predicts/${PREDICT}/oracles`))
    .filter((o) => o.status === 'active')
    .sort((a, b) => a.expiry - b.expiry);
  const o = oracles[0];
  const st = await j(`/oracles/${o.oracle_id}/state`);
  const forward = BigInt(st.latest_price.forward);
  const min = BigInt(o.min_strike);
  const tick = BigInt(o.tick_size);
  const atm = snap(forward, min, tick);

  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC });
  console.log(`oracle ${o.oracle_id.slice(0, 10)}… ${o.underlying_asset} exp ${new Date(o.expiry).toISOString()}`);
  console.log(`forward ${(Number(forward) / 1e9).toFixed(2)}  ATM strike ${(Number(atm) / 1e9).toFixed(0)}  tick ${(Number(tick) / 1e9)}`);
  const qty = 1_000_000n; // 1 contract = $1 max payout

  for (const off of [-2n, 0n, 2n]) {
    const strike = atm + off * tick;
    for (const isUp of [true, false]) {
      const { cost, payout } = await quote(client, {
        oracleId: o.oracle_id, expiry: o.expiry, strike, isUp, quantity: qty,
      });
      const askPct = (Number(cost) / Number(qty)) * 100;
      console.log(
        `  K=${(Number(strike) / 1e9).toFixed(0)} ${isUp ? 'UP ' : 'DN '} ` +
        `cost=$${(Number(cost) / 1e6).toFixed(4)} payout=$${(Number(payout) / 1e6).toFixed(4)} ask=${askPct.toFixed(2)}%`,
      );
    }
  }
  console.log('OK — quote spine validated against live chain.');
};

main().catch((e) => { console.error(e); process.exit(1); });

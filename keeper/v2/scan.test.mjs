// Run: node --test keeper/v2/scan.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { settledMarketMap, orderWins, redeemCandidates, liquidationCandidates } from './scan.mjs';
import { POS_INF_TICK } from './config.mjs';

const TICK = 10_000_000n; // $0.01
const S = (d) => BigInt(d) * 1_000_000_000n; // $ → 1e9-scaled
const upOrder = (strike$, q = 1_000_000n, lev = false) => ({ orderId: 1n, wrapperId: '0xw', lowerTick: (S(strike$) / TICK), higherTick: POS_INF_TICK, quantity: q, isLeveraged: lev });
const dnOrder = (strike$, q = 1_000_000n) => ({ orderId: 2n, wrapperId: '0xw', lowerTick: 0n, higherTick: (S(strike$) / TICK), quantity: q, isLeveraged: false });

test('orderWins: UP wins above strike, loses at/below', () => {
  assert.equal(orderWins(upOrder(60000), S(60100), TICK), true);
  assert.equal(orderWins(upOrder(60000), S(60000), TICK), false); // tie is not "above"
  assert.equal(orderWins(upOrder(60000), S(59900), TICK), false);
});

test('orderWins: DOWN wins at/below strike, loses above', () => {
  assert.equal(orderWins(dnOrder(60000), S(59900), TICK), true);
  assert.equal(orderWins(dnOrder(60000), S(60000), TICK), true); // tie pays DOWN
  assert.equal(orderWins(dnOrder(60000), S(60100), TICK), false);
});

test('orderWins: bounded range (lo, hi]', () => {
  const range = { orderId: 3n, wrapperId: '0xw', lowerTick: S(60000) / TICK, higherTick: S(61000) / TICK, quantity: 1n, isLeveraged: false };
  assert.equal(orderWins(range, S(60500), TICK), true);
  assert.equal(orderWins(range, S(61000), TICK), true); // upper inclusive
  assert.equal(orderWins(range, S(60000), TICK), false); // lower exclusive
  assert.equal(orderWins(range, S(61500), TICK), false);
});

test('settledMarketMap reads settlement price + tick size', () => {
  const m = settledMarketMap([
    { expiry_market_id: '0xm1', settlement: { settlement_price: S(60000).toString() }, market: { tick_size: TICK.toString() } },
    { expiry_market_id: '0xm2', settlement: null, market: { tick_size: TICK.toString() } },
  ]);
  assert.equal(m.size, 1);
  assert.equal(m.get('0xm1').settlementPrice, S(60000));
  assert.equal(m.get('0xm1').tickSize, TICK);
});

test('redeemCandidates: only ITM with open qty', () => {
  const settled = { settlementPrice: S(60100), tickSize: TICK };
  const orders = [upOrder(60000), dnOrder(60000), upOrder(60000, 0n)]; // win, lose, zero-qty
  const out = redeemCandidates('0xm', orders, settled);
  assert.equal(out.length, 1);
  assert.equal(out[0].orderId, 1n);
});

test('liquidationCandidates: only leveraged open orders', () => {
  const orders = [upOrder(60000, 1n, true), upOrder(60000, 1n, false), upOrder(60000, 0n, true)];
  const out = liquidationCandidates('0xm', orders);
  assert.equal(out.length, 1);
});

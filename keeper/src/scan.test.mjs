/**
 * Pure scan tests — run with: node --test
 * No external deps (node:test + node:assert).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  settledOracleMap,
  isInTheMoney,
  redeemCandidatesForManager,
  candidateKey,
} from './scan.mjs';

const oracles = [
  { oracle_id: '0xS1', status: 'settled', settlement_price: 67_000e9, expiry: 100 },
  { oracle_id: '0xS2', status: 'settled', settlement_price: 60_000e9, expiry: 200 },
  { oracle_id: '0xA', status: 'active', settlement_price: null, expiry: 300 },
];

test('settledOracleMap keeps only settled-with-price', () => {
  const m = settledOracleMap(oracles);
  assert.equal(m.size, 2);
  assert.equal(m.get('0xS1').settlementPrice, 67_000e9);
  assert.ok(!m.has('0xA'));
});

test('isInTheMoney: up wins above strike, down wins at-or-below (tie → down)', () => {
  assert.equal(isInTheMoney(true, 67_244e9, 67_164e9), true); // up, SP > K
  assert.equal(isInTheMoney(true, 67_000e9, 67_164e9), false); // up, SP < K
  assert.equal(isInTheMoney(false, 62_791e9, 63_000e9), true); // down, SP < K
  assert.equal(isInTheMoney(false, 63_000e9, 63_000e9), true); // down, tie pays down
  assert.equal(isInTheMoney(false, 63_001e9, 63_000e9), false); // down, SP > K
});

test('redeemCandidatesForManager: only settled + ITM + open', () => {
  const map = settledOracleMap(oracles);
  const positions = [
    // ITM up on S1, open → candidate
    { oracle_id: '0xS1', is_up: true, strike: 66_000e9, open_quantity: 2_000_000 },
    // OTM up on S2 (SP 60k < K 61k) → skip
    { oracle_id: '0xS2', is_up: true, strike: 61_000e9, open_quantity: 1_000_000 },
    // ITM down on S2 (SP 60k <= K 61k) but already redeemed (open 0) → skip
    { oracle_id: '0xS2', is_up: false, strike: 61_000e9, open_quantity: 0 },
    // ITM down on S2, open → candidate
    { oracle_id: '0xS2', is_up: false, strike: 61_000e9, open_quantity: 5_000_000 },
    // active oracle → skip
    { oracle_id: '0xA', is_up: true, strike: 1e9, open_quantity: 9_000_000 },
  ];
  const cands = redeemCandidatesForManager(positions, map);
  assert.equal(cands.length, 2);
  assert.equal(cands[0].oracleId, '0xS1');
  assert.equal(cands[0].quantity, 2_000_000n);
  assert.equal(cands[0].expiry, 100); // from the oracle, not the position
  assert.equal(cands[1].oracleId, '0xS2');
  assert.equal(cands[1].isUp, false);
  assert.equal(cands[1].quantity, 5_000_000n);
});

test('candidateKey is stable and unique per (manager,oracle,strike,dir)', () => {
  const c = { managerId: '0xM', oracleId: '0xS1', strike: 66_000000000000n, isUp: true };
  assert.equal(candidateKey(c), '0xM:0xS1:66000000000000:true');
});

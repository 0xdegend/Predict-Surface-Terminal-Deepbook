/**
 * keeper/src/scan.mjs — PURE candidate detection. No network, no SDK → unit-testable.
 *
 * A redeem candidate is a position that is settled, in-the-money, and still
 * unclaimed. We detect this from numeric fields (oracle.settlement_price vs
 * position.strike/is_up, and open_quantity > 0) rather than the server's status
 * string — verified live (2026-06-06) to agree exactly with status==='redeemable',
 * but robust to status-naming drift. open_quantity is DUSDC base units (@6dec)
 * and equals the on-chain redeemable quantity (pass straight to redeem, no rescale).
 *
 * Settlement rule (mirrors oracle.move::compute_nd2 at the settled boundary):
 *   UP wins   iff settlement_price >  strike
 *   DOWN wins iff settlement_price <= strike   (a tie pays DOWN)
 */

/** Map of settled oracle_id → { settlementPrice, expiry } (1e9-scaled price). */
export function settledOracleMap(oracles) {
  const m = new Map();
  for (const o of oracles) {
    if (o.status === 'settled' && o.settlement_price != null) {
      m.set(o.oracle_id, { settlementPrice: Number(o.settlement_price), expiry: o.expiry });
    }
  }
  return m;
}

export function isInTheMoney(isUp, settlementPrice, strike) {
  return isUp ? settlementPrice > strike : settlementPrice <= strike;
}

/**
 * Redeem candidates within one manager's position list.
 * @returns array of { oracleId, expiry, strike, isUp, quantity, payout }
 *   strike is the raw 1e9-scaled bigint; quantity is the @6dec base-unit bigint.
 */
export function redeemCandidatesForManager(positions, settledMap) {
  const out = [];
  for (const p of positions) {
    const settled = settledMap.get(p.oracle_id);
    if (!settled) continue;
    if (!(p.open_quantity > 0)) continue;
    const strike = Number(p.strike);
    if (!isInTheMoney(p.is_up, settled.settlementPrice, strike)) continue;
    out.push({
      oracleId: p.oracle_id,
      expiry: settled.expiry, // authoritative oracle expiry (key must match)
      strike: BigInt(p.strike),
      isUp: p.is_up,
      quantity: BigInt(Math.round(p.open_quantity)),
      payout: p.open_quantity, // ITM binary pays 1:1 → payout (base units) == quantity
    });
  }
  return out;
}

/** Stable identity for a candidate (dedupe / cooldown key). */
export function candidateKey(c) {
  return `${c.managerId}:${c.oracleId}:${c.strike}:${c.isUp}`;
}

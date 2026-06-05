/**
 * keeper/src/redeem.mjs — build the redeem_permissionless PTB.
 *
 * Mirrors the app's proven lib/sui/predict-tx.ts buildRedeemTx (settled path):
 *   key = market_key::new(oracle_id, expiry, strike, is_up)
 *   predict::redeem_permissionless<Quote>(predict, manager, oracle, key, qty, clock)
 *
 * redeem_permissionless can be called by ANYONE once the oracle is settled — the
 * payout is deposited into the position OWNER's manager, not the keeper. The
 * keeper only spends SUI gas; it claims nothing for itself (an on-chain tip would
 * need protocol support, which this branch doesn't expose — see README).
 */
import { Transaction } from '@mysten/sui/transactions';

export function buildRedeemPermissionlessTx(cfg, c) {
  const tx = new Transaction();
  const key = tx.moveCall({
    target: `${cfg.packageId}::market_key::new`,
    arguments: [
      tx.pure.id(c.oracleId),
      tx.pure.u64(BigInt(c.expiry)),
      tx.pure.u64(c.strike),
      tx.pure.bool(c.isUp),
    ],
  });
  tx.moveCall({
    target: `${cfg.packageId}::predict::redeem_permissionless`,
    typeArguments: [cfg.quoteCoinType],
    arguments: [
      tx.object(cfg.predictObjectId),
      tx.object(c.managerId),
      tx.object(c.oracleId),
      key,
      tx.pure.u64(c.quantity),
      tx.object(cfg.clockId),
    ],
  });
  return tx;
}

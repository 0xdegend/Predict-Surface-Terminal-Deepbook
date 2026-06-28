/**
 * keeper/v2/tx.mjs — PTB builders for the keeper's permissionless v2 actions.
 * Mirror the app's lib/sui/v2/predict-tx.ts (signatures verified from source).
 *
 *  redeem_settled  — claim a settled position; NO auth (deterministic payout to
 *                    the owner's account). Anyone can call it for any wrapper.
 *  liquidate_order — close an underwater leveraged order; permissionless, takes a
 *                    live Pricer. The chain no-ops if the order is healthy, so we
 *                    dry-run first to avoid wasting gas.
 */
import { Transaction } from '@mysten/sui/transactions';

function loadPricer(tx, cfg, marketId) {
  return tx.moveCall({
    target: `${cfg.packageId}::expiry_market::load_live_pricer`,
    arguments: [
      tx.object(marketId),
      tx.object(cfg.protocolConfigId),
      tx.object(cfg.oracleRegistryId),
      tx.object(cfg.pythFeedId),
      tx.object(cfg.bsSpotFeedId),
      tx.object(cfg.bsForwardFeedId),
      tx.object(cfg.bsSviFeedId),
      tx.object(cfg.clockId),
    ],
  });
}

export function buildRedeemSettledTx(cfg, c) {
  const tx = new Transaction();
  tx.moveCall({
    target: `${cfg.packageId}::expiry_market::redeem_settled`,
    arguments: [
      tx.object(c.marketId),
      tx.object(cfg.accountRegistryId),
      tx.object(c.wrapperId),
      tx.object(cfg.protocolConfigId),
      tx.object(cfg.oracleRegistryId),
      tx.object(cfg.pythFeedId),
      tx.pure.u256(c.orderId),
      tx.pure.u64(c.closeQuantity),
      tx.object(cfg.accumulatorRootId),
      tx.object(cfg.clockId),
    ],
  });
  return tx;
}

export function buildLiquidateOrderTx(cfg, c) {
  const tx = new Transaction();
  const pricer = loadPricer(tx, cfg, c.marketId);
  tx.moveCall({
    target: `${cfg.packageId}::expiry_market::liquidate_order`,
    arguments: [tx.object(c.marketId), tx.object(cfg.protocolConfigId), pricer, tx.pure.u256(c.orderId)],
  });
  return tx;
}

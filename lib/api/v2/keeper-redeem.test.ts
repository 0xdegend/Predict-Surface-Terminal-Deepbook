import { describe, it, expect } from 'vitest';
import { redeemKey, openMarketsIn } from './onchain';
import type { V2OrderEvent } from './types';

/**
 * Guards the keeper-redeem read fix (onchainOwnerOrders). Settled winners are
 * auto-redeemed by the protocol keeper via redeem_settled_permissionless — signed by the
 * keeper, so the owner/session sender scan never sees it, and the already-paid position
 * would linger as "open" with a Redeem that aborts. onchainOwnerOrders folds those keeper
 * redeems in per-market. Two pure pieces drive that: which markets to scan (openMarketsIn)
 * and dedupe so a self-signed redeem isn't counted twice (redeemKey).
 */
const mint = (root: string, market: string, qty: number): V2OrderEvent => ({
  kind: 'order_minted',
  position_root_id: root,
  expiry_market_id: market,
  quantity: qty,
  minted_at_ms: 1000,
});
const redeem = (root: string, qtyClosed: number, atMs: number): V2OrderEvent => ({
  kind: 'settled_order_redeemed',
  position_root_id: root,
  quantity_closed: qtyClosed,
  redeemed_at_ms: atMs,
  payout_amount: qtyClosed,
});

describe('openMarketsIn', () => {
  it('returns only markets whose position is still net-open', () => {
    const orders = [
      mint('A', '0xmarketA', 100),
      mint('B', '0xmarketB', 50),
      redeem('A', 100, 2000), // A fully closed → its market drops out
    ];
    expect(openMarketsIn(orders)).toEqual(['0xmarketB']);
  });

  it('once the keeper redeem is folded in, the paid market is no longer open', () => {
    const open = [mint('A', '0xmarketA', 100)];
    expect(openMarketsIn(open)).toEqual(['0xmarketA']); // looks open before the keeper redeem
    expect(openMarketsIn([...open, redeem('A', 100, 2000)])).toEqual([]); // closed after
  });

  it('keeps a partially-closed position open', () => {
    expect(openMarketsIn([mint('A', '0xmarketA', 100), redeem('A', 40, 2000)])).toEqual(['0xmarketA']);
  });
});

describe('redeemKey', () => {
  it('is identical for the same redeem seen by two scans (so it dedupes)', () => {
    // Same event, captured via the sender scan and the per-market scan: identical parsedJson.
    const senderView = redeem('A', 100, 2000);
    const marketView = { ...redeem('A', 100, 2000), checkpoint_timestamp_ms: 2000 };
    expect(redeemKey(senderView)).toBe(redeemKey(marketView));
  });

  it('differs for two distinct partial closes of the same root', () => {
    expect(redeemKey(redeem('A', 40, 2000))).not.toBe(redeemKey(redeem('A', 60, 3000)));
  });
});

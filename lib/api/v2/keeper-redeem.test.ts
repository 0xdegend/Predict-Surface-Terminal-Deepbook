import { describe, it, expect } from 'vitest';
import { redeemKey, openMarketsIn, openRootsByMarket, foldOpenPositions } from './onchain';
import { createClosedRootsGuard } from '@/lib/portfolio/closed-roots-guard';
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

  it('does not cap the markets it reports (every open market is scanned, not just the first 12)', () => {
    // A heavy account with 20 open markets: the fix scans ALL of them, so a keeper-claimed
    // position in the 13th+ market is no longer stranded as "ready to redeem".
    const orders = Array.from({ length: 20 }, (_, i) => mint(`root${i}`, `0xmarket${i}`, 100));
    expect(openMarketsIn(orders)).toHaveLength(20);
  });
});

describe('openRootsByMarket', () => {
  it('groups each open market to its still-open roots (drives the early-stop per-market scan)', () => {
    const byMarket = openRootsByMarket([
      mint('A', '0xmarketA', 100),
      mint('B', '0xmarketA', 100), // two open positions in the same market
      mint('C', '0xmarketB', 100),
      redeem('C', 100, 2000), // C fully closed → market B drops out entirely
    ]);
    expect([...byMarket.keys()]).toEqual(['0xmarketA']);
    expect(byMarket.get('0xmarketA')).toEqual(new Set(['A', 'B']));
  });

  it('drops a root from its market set once its redeem is folded (so that scan can stop)', () => {
    const byMarket = openRootsByMarket([
      mint('A', '0xmarketA', 100),
      mint('B', '0xmarketA', 100),
      redeem('A', 100, 2000), // A closed; only B is still open
    ]);
    expect(byMarket.get('0xmarketA')).toEqual(new Set(['B']));
  });
});

describe('foldOpenPositions + closed-roots guard (flicker fix)', () => {
  const marketA = '0xmarketA';

  it('a failed redeem scan does not resurrect a root the guard saw closed', () => {
    const guard = createClosedRootsGuard();

    // Poll 1: the keeper's closing redeem IS read → A folds to closed, guard records it.
    const closed = foldOpenPositions([mint('A', marketA, 100), redeem('A', 100, 2000)], guard);
    expect(closed).toEqual([]);

    // Poll 2: the per-market redeem scan 429s, so the redeem is MISSING and A nets open
    // again. Without the guard this is the flicker — A comes back as a claimable card:
    const resurrected = foldOpenPositions([mint('A', marketA, 100)]);
    expect(resurrected).toHaveLength(1);

    // With the guard, the known-closed root is suppressed, so the paid position stays gone.
    const suppressed = foldOpenPositions([mint('A', marketA, 100)], guard);
    expect(suppressed).toEqual([]);
  });

  it('never suppresses a genuinely open position (only confirmed closes are remembered)', () => {
    const guard = createClosedRootsGuard();
    // A is fully closed (recorded); B is still open the whole time.
    foldOpenPositions([mint('A', marketA, 100), redeem('A', 100, 2000), mint('B', marketA, 50)], guard);
    const open = foldOpenPositions([mint('A', marketA, 100), mint('B', marketA, 50)], guard);
    expect(open.map((p) => p.position_root_id)).toEqual(['B']); // A suppressed, B kept
  });

  it('does not record a partially-closed root as closed (it is still open)', () => {
    const guard = createClosedRootsGuard();
    // Partial close: remaining > 0, so the guard must NOT mark it closed.
    foldOpenPositions([mint('A', marketA, 100), redeem('A', 40, 2000)], guard);
    // Later the partial redeem is missed by the scan → A is fully open again, and since it
    // was never confirmed closed, it correctly shows as open (not suppressed).
    const open = foldOpenPositions([mint('A', marketA, 100)], guard);
    expect(open.map((p) => p.position_root_id)).toEqual(['A']);
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

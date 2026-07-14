import { describe, it, expect } from 'vitest';
import { classifyV2Traders } from './v2-trader-style';
import type { V2OrderEvent } from '@/lib/api/v2/types';

const POS_INF = 1073741823;

// A minted order for `owner`, UP by default, $stake staked at `entry` probability.
const mint = (owner: string, o: Partial<V2OrderEvent> = {}): V2OrderEvent => ({
  kind: 'order_minted',
  owner,
  expiry_market_id: '0xA',
  lower_tick: 6_380_200,
  higher_tick: POS_INF,
  net_premium: '5000000', // $5
  entry_probability: 700_000_000, // 0.70
  ...o,
});

function byMarket(...orders: V2OrderEvent[]): Map<string, V2OrderEvent[]> {
  return new Map([['0xA', orders]]);
}

describe('classifyV2Traders', () => {
  it('classifies a safe bettor: many high-probability favorites', () => {
    // 5 bets, all at 0.9 entry → favorite lean.
    const orders = Array.from({ length: 5 }, (_, i) =>
      mint('0xfav', { entry_probability: 900_000_000, expiry_market_id: `0x${i}` }),
    );
    const { traders, distribution, total } = classifyV2Traders(byMarket(...orders));
    expect(total).toBe(1);
    expect(traders[0].owner).toBe('0xfav');
    expect(traders[0].style.primary?.id).toBe('favorite');
    expect(traders[0].volume).toBeCloseTo(25, 6); // 5 × $5
    expect(distribution[0]).toMatchObject({ id: 'favorite', count: 1 });
  });

  it('classifies a longshot hunter: cheap bets on unlikely outcomes', () => {
    const orders = Array.from({ length: 5 }, (_, i) =>
      mint('0xtail', { entry_probability: 120_000_000, expiry_market_id: `0x${i}` }),
    ); // 0.12 entry → tail
    const style = classifyV2Traders(byMarket(...orders)).traders[0].style;
    expect(style.primary?.id).toBe('tail');
  });

  it('folds range mints into range volume → in-between bettor', () => {
    // Enough binary bets to clear the sample floor, but mostly range by volume
    // (two finite ticks) → range archetype. A pure-range trader isn't classified;
    // range is a lean measured on top of a classifiable binary history.
    const binary = Array.from({ length: 3 }, (_, i) => mint('0xrange', { expiry_market_id: `0xb${i}` }));
    const range = Array.from({ length: 6 }, (_, i) =>
      mint('0xrange', { lower_tick: 6_300_000, higher_tick: 6_400_000, expiry_market_id: `0xr${i}` }),
    );
    // range volume 30 / total 45 = 0.67 ≥ 0.4 → range.
    expect(classifyV2Traders(byMarket(...binary, ...range)).traders[0].style.primary?.id).toBe('range');
  });

  it('drops traders below the classifier’s sample floor', () => {
    // A single bet is not enough to read a style.
    const { traders, total } = classifyV2Traders(byMarket(mint('0xthin')));
    expect(total).toBe(0);
    expect(traders).toEqual([]);
  });

  it('ranks the roster by amount bet and counts the distribution', () => {
    const big = Array.from({ length: 5 }, (_, i) =>
      mint('0xbig', { entry_probability: 900_000_000, net_premium: '20000000', expiry_market_id: `0x${i}` }),
    );
    const small = Array.from({ length: 5 }, (_, i) =>
      mint('0xsmall', { entry_probability: 900_000_000, net_premium: '3000000', expiry_market_id: `0x${i}` }),
    );
    const { traders, distribution, total } = classifyV2Traders(new Map([['0xA', [...small, ...big]]]));
    expect(total).toBe(2);
    expect(traders.map((t) => t.owner)).toEqual(['0xbig', '0xsmall']); // volume desc
    expect(distribution.reduce((s, d) => s + d.count, 0)).toBe(2);
  });

  it('ignores redeems and owner-less rows', () => {
    const orders = [
      { kind: 'live_order_redeemed', owner: '0xghost' } as V2OrderEvent,
      mint('', {}), // no owner
    ];
    expect(classifyV2Traders(byMarket(...orders)).total).toBe(0);
  });
});

import { describe, it, expect } from 'vitest';
import { buildMarketBook, maxPainOf, payoutAt, paidProbAt, EMPTY_BOOK, MIN_PAIN_BETS, type BookStrike } from './market-book';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import type { V2OrderEvent } from '@/lib/api/v2/types';

/** $1 ticks, so a tick index reads as dollars. */
const TICK = '1000000000';
const usd = (v: number) => String(Math.round(v * 1e6)); // 6-dec base units
const prob = (p: number) => String(Math.round(p * 1e9)); // 1e9-scaled

let seq = 0;
function mint(o: {
  strike: number;
  isUp: boolean;
  stake: number;
  notional?: number;
  entry?: number;
  owner?: string;
}): V2OrderEvent {
  seq += 1;
  return {
    kind: 'order_minted',
    order_id: seq,
    owner: o.owner ?? `0xtrader${seq}`,
    net_premium: usd(o.stake),
    quantity: usd(o.notional ?? o.stake * 2),
    entry_probability: o.entry != null ? prob(o.entry) : undefined,
    lower_tick: o.isUp ? String(o.strike) : '0',
    higher_tick: o.isUp ? String(POS_INF_TICK) : String(o.strike),
  };
}

function rangeMint(lower: number, higher: number, stake: number): V2OrderEvent {
  seq += 1;
  return {
    kind: 'order_minted',
    order_id: seq,
    owner: `0xrange${seq}`,
    net_premium: usd(stake),
    quantity: usd(stake * 3),
    lower_tick: String(lower),
    higher_tick: String(higher),
  };
}

describe('buildMarketBook', () => {
  it('is empty for no orders', () => {
    expect(buildMarketBook([], TICK)).toEqual(EMPTY_BOOK);
    expect(buildMarketBook(undefined, TICK)).toEqual(EMPTY_BOOK);
  });

  it('places each side at its own strike, decoded from the tick pair', () => {
    const book = buildMarketBook(
      [mint({ strike: 64_000, isUp: true, stake: 10 }), mint({ strike: 65_000, isUp: false, stake: 25 })],
      TICK,
    );
    expect(book.strikes.map((k) => k.strike)).toEqual([64_000, 65_000]);
    expect(book.strikes[0].up.stakeUsd).toBeCloseTo(10, 6);
    expect(book.strikes[0].down.stakeUsd).toBe(0);
    expect(book.strikes[1].down.stakeUsd).toBeCloseTo(25, 6);
    expect(book.strikes[1].up.stakeUsd).toBe(0);
  });

  it('totals premium, notional, bets and distinct traders', () => {
    const book = buildMarketBook(
      [
        mint({ strike: 64_000, isUp: true, stake: 10, notional: 20, owner: '0xa' }),
        mint({ strike: 64_000, isUp: true, stake: 30, notional: 60, owner: '0xa' }), // same trader
        mint({ strike: 65_000, isUp: false, stake: 20, notional: 50, owner: '0xb' }),
      ],
      TICK,
    );
    expect(book.bets).toBe(3);
    expect(book.traders).toBe(2);
    expect(book.stakeUsd).toBeCloseTo(60, 6);
    expect(book.notionalUsd).toBeCloseTo(130, 6);
  });

  it('weights the up/down lean by premium, not by bet count', () => {
    const book = buildMarketBook(
      [
        mint({ strike: 64_000, isUp: true, stake: 90 }),
        mint({ strike: 64_000, isUp: false, stake: 5 }),
        mint({ strike: 65_000, isUp: false, stake: 5 }),
      ],
      TICK,
    );
    expect(book.upShare).toBeCloseTo(0.9, 6); // 2 of 3 bets are down, 90% of the money is up
  });

  it('reports a premium-weighted paid probability per side', () => {
    const book = buildMarketBook(
      [
        mint({ strike: 64_000, isUp: true, stake: 100, entry: 0.6 }),
        mint({ strike: 64_000, isUp: true, stake: 300, entry: 0.7 }),
      ],
      TICK,
    );
    // (100*0.6 + 300*0.7) / 400 = 0.675
    expect(book.strikes[0].up.paidProb).toBeCloseTo(0.675, 9);
    expect(book.strikes[0].down.paidProb).toBeNull();
  });

  it('leaves paidProb null when the feed carried no entry probability', () => {
    const book = buildMarketBook([mint({ strike: 64_000, isUp: true, stake: 10 })], TICK);
    expect(book.strikes[0].up.paidProb).toBeNull();
  });

  it('counts range bets in the totals but gives them no strike', () => {
    const book = buildMarketBook(
      [mint({ strike: 64_000, isUp: true, stake: 10 }), rangeMint(63_000, 65_000, 40)],
      TICK,
    );
    expect(book.rangeStakeUsd).toBeCloseTo(40, 6);
    expect(book.stakeUsd).toBeCloseTo(50, 6);
    expect(book.strikes).toHaveLength(1); // only the binary
    expect(book.upShare).toBe(1); // the range is excluded from the lean
  });

  it('names the busiest strike and the biggest single bet', () => {
    const book = buildMarketBook(
      [
        mint({ strike: 64_000, isUp: true, stake: 10 }),
        mint({ strike: 65_000, isUp: true, stake: 40, owner: '0xwhale' }),
        mint({ strike: 65_000, isUp: false, stake: 5 }),
      ],
      TICK,
    );
    expect(book.busiestStrike).toBe(65_000);
    expect(book.biggest).toMatchObject({ stakeUsd: 40, side: 'up', strike: 65_000, trader: '0xwhale' });
  });

  it('ignores redeems and other non-mint events', () => {
    const book = buildMarketBook(
      [
        mint({ strike: 64_000, isUp: true, stake: 10 }),
        { kind: 'settled_order_redeemed', payout_amount: usd(999), owner: '0xz' },
        { kind: 'live_order_redeemed', redeem_amount: usd(500), owner: '0xz' },
      ],
      TICK,
    );
    expect(book.bets).toBe(1);
    expect(book.stakeUsd).toBeCloseTo(10, 6);
  });

  it('skips zero-premium rows rather than counting them as bets', () => {
    expect(buildMarketBook([mint({ strike: 64_000, isUp: true, stake: 0 })], TICK).bets).toBe(0);
  });
});

describe('payoutAt', () => {
  const strikes: BookStrike[] = [
    { strike: 64_000, up: side(100), down: side(0), stakeUsd: 0 },
    { strike: 66_000, up: side(0), down: side(300), stakeUsd: 0 },
  ];

  it('pays UP strictly above its strike, DOWN at or below', () => {
    expect(payoutAt(strikes, 63_000)).toBe(300); // below both: the 66k down wins
    expect(payoutAt(strikes, 64_000)).toBe(300); // AT the up strike is not "above"
    expect(payoutAt(strikes, 65_000)).toBe(400); // up 64k wins, down 66k wins
    expect(payoutAt(strikes, 67_000)).toBe(100); // above both: only the 64k up wins
  });
});

describe('maxPainOf', () => {
  it('is null for an empty book', () => {
    expect(maxPainOf([])).toBeNull();
  });

  it('finds the settlement price that owes the least', () => {
    // Heavy UP interest low, heavy DOWN interest high: the cheapest place to land is
    // below everything, where only the small down side pays.
    const strikes: BookStrike[] = [
      { strike: 64_000, up: side(1_000), down: side(0), stakeUsd: 0 },
      { strike: 66_000, up: side(0), down: side(10), stakeUsd: 0 },
    ];
    const pain = maxPainOf(strikes)!;
    expect(payoutAt(strikes, pain)).toBe(10);
    expect(pain).toBeLessThanOrEqual(64_000);
  });

  it('never picks a price that costs more than another candidate', () => {
    const strikes: BookStrike[] = [
      { strike: 60_000, up: side(50), down: side(20), stakeUsd: 0 },
      { strike: 64_000, up: side(10), down: side(90), stakeUsd: 0 },
      { strike: 68_000, up: side(70), down: side(30), stakeUsd: 0 },
    ];
    const pain = maxPainOf(strikes)!;
    const owed = payoutAt(strikes, pain);
    for (const probe of [55_000, 60_000, 62_000, 64_000, 66_000, 68_000, 72_000]) {
      expect(owed).toBeLessThanOrEqual(payoutAt(strikes, probe) + 1e-9);
    }
  });

  it('resolves ties to the lowest candidate, so it does not hop between equal minima', () => {
    const strikes: BookStrike[] = [
      { strike: 64_000, up: side(0), down: side(0), stakeUsd: 0 },
      { strike: 66_000, up: side(0), down: side(0), stakeUsd: 0 },
    ];
    expect(maxPainOf(strikes)).toBeLessThan(64_000);
  });

  it('is suppressed on a thin book rather than shown as a real pin', () => {
    const thin = Array.from({ length: MIN_PAIN_BETS - 1 }, (_, i) =>
      mint({ strike: 64_000 + i * 100, isUp: true, stake: 10 }),
    );
    expect(buildMarketBook(thin, TICK).maxPain).toBeNull();

    const thick = Array.from({ length: MIN_PAIN_BETS }, (_, i) =>
      mint({ strike: 64_000 + i * 100, isUp: true, stake: 10 }),
    );
    expect(buildMarketBook(thick, TICK).maxPain).not.toBeNull();
  });
});

describe('paidProbAt', () => {
  const book = buildMarketBook(
    [
      mint({ strike: 64_000, isUp: true, stake: 200, entry: 0.55 }),
      mint({ strike: 64_000, isUp: false, stake: 50, entry: 0.44 }),
    ],
    TICK,
  );

  it('returns what the crowd paid for that exact strike and side', () => {
    expect(paidProbAt(book, 64_000, true)).toMatchObject({ prob: 0.55 });
    expect(paidProbAt(book, 64_000, false)).toMatchObject({ prob: 0.44 });
  });

  it('carries the stake behind it, so the UI can weigh how much money that is', () => {
    expect(paidProbAt(book, 64_000, true)!.stakeUsd).toBeCloseTo(200, 6);
  });

  it('is null where nobody has traded, rather than inventing a price', () => {
    expect(paidProbAt(book, 70_000, true)).toBeNull();
    expect(paidProbAt(EMPTY_BOOK, 64_000, true)).toBeNull();
  });
});

/** A BookSide carrying only the notional the payout maths needs. */
function side(notionalUsd: number) {
  return { stakeUsd: 0, notionalUsd, bets: 0, paidProb: null };
}

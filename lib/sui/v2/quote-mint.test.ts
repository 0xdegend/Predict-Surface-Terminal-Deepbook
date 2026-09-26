import { describe, it, expect } from 'vitest';
import { parseMintQuote } from './quote-mint';

const minted = (json: Record<string, unknown>) => ({
  $kind: 'Transaction',
  Transaction: {
    events: [
      { eventType: '0xabc::order_events::Other', json: { entry_probability: '1' } },
      { eventType: '0xabc::order_events::OrderMinted', json },
    ],
  },
  commandResults: [],
});

describe('parseMintQuote', () => {
  it('reads the chain price, premium, quantity and builder fee off the simulated OrderMinted', () => {
    const q = parseMintQuote(minted({ entry_probability: '759336053', premium: '4996431', quantity: '6580000', builder_fee: '21700' }));
    expect(q).not.toBeNull();
    expect(q!.entryProb).toBeCloseTo(0.759336053, 9);
    expect(q!.premiumBase).toBe(4_996_431n);
    expect(q!.quantityBase).toBe(6_580_000n);
    expect(q!.builderFeeBase).toBe(21_700n);
  });

  it('accepts the older net_premium name, and every absent charge reads as zero', () => {
    const q = parseMintQuote(minted({ entry_probability: '500000000', net_premium: '10', quantity: '20' }));
    expect(q).toEqual({
      entryProb: 0.5,
      premiumBase: 10n,
      quantityBase: 20n,
      builderFeeBase: 0n,
      tradingFeeBase: 0n,
      feeSubsidyBase: 0n,
      inventoryImpactBase: 0n,
      penaltyFeeBase: 0n,
      referralFeeBase: 0n,
      // Nothing but the premium is known, so that is all we would fund. A missing charge
      // must never read as anything other than zero or the total silently under-reserves.
      totalCostBase: 10n,
    });
  });

  // The whole reason this parser carries every charge: `stake + base_fee × quantity`
  // under-reserved a real mainnet bet and the chain refused it. These are the terms of
  // `expiry_market::compute_mint_quote`, and the total has to be their exact sum.
  describe('totalCostBase — what the account must actually hold', () => {
    it('sums every charge the chain reports, not just the premium and the fee', () => {
      const q = parseMintQuote(
        minted({
          entry_probability: '278775898',
          premium: '1697745',
          quantity: '6090000',
          trading_fee: '557070',
          builder_fee: '30450',
          fee_incentive_subsidy: '0',
          inventory_impact_charge: '0',
          penalty_fee: '0',
          referral_fee: '0',
        }),
      );
      // Read off a live mainnet simulation, 2026-09-26, 327s to expiry.
      expect(q!.totalCostBase).toBe(1_697_745n + 557_070n + 30_450n);
      // And the reason the old estimate failed: the applied trading fee is 9.148% of
      // quantity (0.0914729 exactly) while the market's own `base_fee` field reads 20.4%.
      expect(Number(q!.tradingFeeBase) / Number(q!.quantityBase)).toBeCloseTo(0.0915, 4);
    });

    it('subtracts the fee-incentive subsidy, which is a rebate on the trading fee', () => {
      const q = parseMintQuote(
        minted({ entry_probability: '5', premium: '1000', quantity: '9999', trading_fee: '300', fee_incentive_subsidy: '120' }),
      );
      expect(q!.totalCostBase).toBe(1000n + (300n - 120n));
    });

    it('never lets a subsidy larger than the fee reduce the total below the premium', () => {
      const q = parseMintQuote(
        minted({ entry_probability: '5', premium: '1000', quantity: '9999', trading_fee: '100', fee_incentive_subsidy: '999999' }),
      );
      expect(q!.totalCostBase).toBe(1000n);
    });

    it('counts the inventory, penalty and referral charges too', () => {
      const q = parseMintQuote(
        minted({
          entry_probability: '5',
          premium: '1000',
          quantity: '9999',
          trading_fee: '10',
          builder_fee: '20',
          inventory_impact_charge: '30',
          penalty_fee: '40',
          referral_fee: '50',
        }),
      );
      expect(q!.totalCostBase).toBe(1000n + 10n + 20n + 30n + 40n + 50n);
    });
  });

  it('is null when the simulation minted nothing', () => {
    expect(parseMintQuote({ $kind: 'FailedTransaction', FailedTransaction: { status: { error: 'abort' } } })).toBeNull();
    expect(parseMintQuote({ Transaction: { events: [] } })).toBeNull();
    expect(parseMintQuote(null)).toBeNull();
  });

  it('is null when the event is missing a number it needs', () => {
    expect(parseMintQuote(minted({ premium: '1', quantity: '2' }))).toBeNull();
  });
});

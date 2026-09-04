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

  it('accepts the older net_premium name and a missing builder fee', () => {
    const q = parseMintQuote(minted({ entry_probability: '500000000', net_premium: '10', quantity: '20' }));
    expect(q).toEqual({ entryProb: 0.5, premiumBase: 10n, quantityBase: 20n, builderFeeBase: 0n });
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

import { describe, it, expect } from 'vitest';
import {
  buildSessionMintTx,
  buildSessionMintBudgetTx,
  buildSessionRedeemLiveTx,
  buildSessionRedeemSettledTx,
} from './session-tx';
import { predictV2Config } from '@/config/predict';

const MARKET = '0x2222222222222222222222222222222222222222222222222222222222222222';
const WRAPPER = '0x3333333333333333333333333333333333333333333333333333333333333333';

interface MoveCall {
  package: string;
  module: string;
  function: string;
  arguments: unknown[];
}
const moveCalls = (tx: { getData: () => { commands: unknown[] } }): MoveCall[] =>
  tx
    .getData()
    .commands.map((cmd) => (cmd as { MoveCall?: MoveCall }).MoveCall)
    .filter((c): c is MoveCall => !!c);

/** The single sessions:: call in a built trade PTB. */
const sessionCall = (tx: { getData: () => { commands: unknown[] } }): MoveCall => {
  const c = moveCalls(tx).find((m) => m.module === 'sessions');
  if (!c) throw new Error('no sessions:: call in tx');
  return c;
};

describe('session trade builders target the sessions package', () => {
  it('mint_exact_quantity: sessions module, right fn, 13 args (registry inserted, no auth)', () => {
    const tx = buildSessionMintTx({
      marketId: MARKET,
      wrapperId: WRAPPER,
      lowerTick: 1n,
      higherTick: 2n,
      quantity: 1_000_000n,
      leverage: 1_000_000_000n,
      maxCost: 5_000_000n,
      maxProbability: 900_000_000n,
    });
    const c = sessionCall(tx);
    expect(c.package).toBe(predictV2Config.packages.sessions);
    expect(c.module).toBe('sessions');
    expect(c.function).toBe('mint_exact_quantity');
    // market, account_registry, wrapper, config, pricer, lower, higher, quantity,
    // leverage, max_cost, max_probability, root, clock
    expect(c.arguments).toHaveLength(13);
    // A live Pricer is built inline via the public read-only load_live_pricer.
    expect(moveCalls(tx).some((m) => m.function === 'load_live_pricer')).toBe(true);
    // No owner Auth is minted on the session path (that gate is the session itself).
    expect(moveCalls(tx).some((m) => m.function === 'generate_auth')).toBe(false);
  });

  it('mint_exact_amount: sessions module, right fn, 13 args (always carries max_cost)', () => {
    const tx = buildSessionMintBudgetTx({
      marketId: MARKET,
      wrapperId: WRAPPER,
      lowerTick: 1n,
      higherTick: 2n,
      amount: 3_000_000n,
      minQuantity: 1_000_000n,
      leverage: 1_000_000_000n,
    });
    const c = sessionCall(tx);
    expect(c.package).toBe(predictV2Config.packages.sessions);
    expect(c.function).toBe('mint_exact_amount');
    // market, registry, wrapper, config, pricer, lower, higher, max_premium,
    // min_quantity, leverage, max_cost, root, clock
    expect(c.arguments).toHaveLength(13);
    expect(moveCalls(tx).some((m) => m.function === 'load_live_pricer')).toBe(true);
  });

  it('redeem_live: sessions module, right fn, 11 args, with a Pricer', () => {
    const tx = buildSessionRedeemLiveTx({
      marketId: MARKET,
      wrapperId: WRAPPER,
      orderId: 42n,
      closeQuantity: 0n,
    });
    const c = sessionCall(tx);
    expect(c.function).toBe('redeem_live');
    // market, registry, wrapper, config, pricer, order_id, close_quantity,
    // min_probability, min_proceeds, root, clock
    expect(c.arguments).toHaveLength(11);
    expect(moveCalls(tx).some((m) => m.function === 'load_live_pricer')).toBe(true);
  });

  it('redeem_settled: sessions module, right fn, 8 args, NO Pricer', () => {
    const tx = buildSessionRedeemSettledTx({
      marketId: MARKET,
      wrapperId: WRAPPER,
      orderId: 42n,
      closeQuantity: 0n,
    });
    const c = sessionCall(tx);
    expect(c.function).toBe('redeem_settled');
    // market, registry, wrapper, config, order_id, close_quantity, root, clock
    expect(c.arguments).toHaveLength(8);
    // Settlement price is stored on the market — no live Pricer.
    expect(moveCalls(tx).some((m) => m.function === 'load_live_pricer')).toBe(false);
  });
});

/**
 * lib/sui/v2/session-tx.ts — trade PTBs signed by the SESSION key (Phase 2).
 *
 * These mirror the owner-signed builders in predict-tx.ts but target the
 * `deepbook_sessions::sessions` wrappers instead of `expiry_market::*`. Two
 * differences, both verified from source (sessions.move on predict-testnet-7-29):
 *
 *  1. `account_registry` is inserted as the SECOND argument (after `market`) — the
 *     wrapper alone can't be resolved to an account from a non-owner sender, so the
 *     session wrappers take the registry to look it up.
 *  2. There is NO `Auth` argument. Instead the sessions module's private
 *     `generate_auth_as_session` asserts the TX SENDER is an authorized, unexpired
 *     session on that wrapper, then mints the Auth internally. So the session key
 *     signs and sends the tx directly — no owner popup, no `generate_auth` here.
 *
 * A session can therefore ONLY call these four wrappers on the wrapper (no deposit,
 * no withdraw, no builder-code attach — those stay owner-gated). It trades against
 * the DUSDC the owner pre-deposited; there is no `deposit`/`attachBuilderCode` here.
 *
 * Sessions exist only on the 8-06 (7-29+) deployment, so these always use the
 * 7-29+ argument shape (max_cost on mint_exact_amount; the auth-less, registry-
 * carrying redeem_settled). The Pricer is built inline via the same public,
 * read-only `load_live_pricer` the owner path uses.
 */
import { Transaction } from '@mysten/sui/transactions';
import { predictV2Config, v2SessionTarget } from '@/config/predict';
import { buildLoadPricerCall } from './pricer';
import type { MintParams, MintBudgetParams, RedeemParams } from './predict-tx';

const c = () => predictV2Config;

/** `${sessions_pkg}::sessions::<fn>`. */
const SESS = (fn: string) => v2SessionTarget('sessions', fn);

/** u64 max — the "no added cost cap" sentinel (the `amount` budget already bounds spend). */
const U64_MAX = 18446744073709551615n;

/** The `deposit`/`attachBuilderCode` fields never apply to a session trade. */
type SessionMint = Omit<MintParams, 'deposit' | 'attachBuilderCode'>;
type SessionMintBudget = Omit<MintBudgetParams, 'deposit' | 'attachBuilderCode'>;

/**
 * mint_exact_quantity via the session — open a position of exactly `quantity`
 * max-payout, signed by the session key. No deposit (the session trades the
 * pre-funded budget), no builder-code attach (owner-gated; done at authorize).
 */
export function buildSessionMintTx(p: SessionMint): Transaction {
  const tx = new Transaction();
  const pricer = buildLoadPricerCall(tx, p.marketId);
  tx.moveCall({
    target: SESS('mint_exact_quantity'),
    arguments: [
      tx.object(p.marketId),
      tx.object(c().shared.accountRegistry),
      tx.object(p.wrapperId),
      tx.object(c().shared.protocolConfig),
      pricer,
      tx.pure.u64(p.lowerTick),
      tx.pure.u64(p.higherTick),
      tx.pure.u64(p.quantity),
      tx.pure.u64(p.leverage),
      tx.pure.u64(p.maxCost),
      tx.pure.u64(p.maxProbability),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

/** mint_exact_amount (the budget path) via the session. Always carries the 7-29+
 *  all-in cost cap; defaults to no cap since `amount` already bounds the premium. */
export function buildSessionMintBudgetTx(p: SessionMintBudget): Transaction {
  const tx = new Transaction();
  const pricer = buildLoadPricerCall(tx, p.marketId);
  tx.moveCall({
    target: SESS('mint_exact_amount'),
    arguments: [
      tx.object(p.marketId),
      tx.object(c().shared.accountRegistry),
      tx.object(p.wrapperId),
      tx.object(c().shared.protocolConfig),
      pricer,
      tx.pure.u64(p.lowerTick),
      tx.pure.u64(p.higherTick),
      tx.pure.u64(p.amount),
      tx.pure.u64(p.minQuantity),
      tx.pure.u64(p.leverage),
      tx.pure.u64(p.maxCost ?? U64_MAX),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

/** redeem_live via the session — close (part of) a live position (needs a Pricer). */
export function buildSessionRedeemLiveTx(p: RedeemParams): Transaction {
  const tx = new Transaction();
  const pricer = buildLoadPricerCall(tx, p.marketId);
  tx.moveCall({
    target: SESS('redeem_live'),
    arguments: [
      tx.object(p.marketId),
      tx.object(c().shared.accountRegistry),
      tx.object(p.wrapperId),
      tx.object(c().shared.protocolConfig),
      pricer,
      tx.pure.u256(p.orderId),
      tx.pure.u64(p.closeQuantity),
      tx.pure.u64(p.minProbability ?? 0n),
      tx.pure.u64(p.minProceeds ?? 0n),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

/** redeem_settled via the session — claim a settled position (no Pricer; the
 *  settlement price is stored on the market). The 7-29+ auth-less, registry shape. */
export function buildSessionRedeemSettledTx(p: RedeemParams): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: SESS('redeem_settled'),
    arguments: [
      tx.object(p.marketId),
      tx.object(c().shared.accountRegistry),
      tx.object(p.wrapperId),
      tx.object(c().shared.protocolConfig),
      tx.pure.u256(p.orderId),
      tx.pure.u64(p.closeQuantity),
      tx.object(c().accumulatorRootId),
      tx.object(c().clockId),
    ],
  });
  return tx;
}

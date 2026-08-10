/**
 * lib/sui/v2/abort.ts — plain-language errors for the v2 deployment.
 *
 * Wallet/session/network handling is shared with the legacy decoder; only the
 * Move-abort module map differs (new packages: expiry_market, account, pricing,
 * plp). Codes verified from source (predict-testnet-6-24). Copy is deliberately
 * jargon-free per the migration quality bar.
 */
import { humanizeError as humanizeWalletError } from '@/lib/sui/abort';

const V2_ABORTS: Record<string, string> = {
  // expiry_market
  'expiry_market:0': 'New positions are paused on this market right now.',
  'expiry_market:1': 'A leveraged position has to be closed in full, not partially.',
  'expiry_market:2': 'This market hasn’t settled yet — you can’t claim it as settled.',
  'expiry_market:3': 'Wrong price feed for this market. Refresh and retry.',
  'expiry_market:4': 'The cost moved above your limit. Nudge slippage up or try again.',
  'expiry_market:5': 'The odds moved past your limit. Nudge slippage up or try again.',
  'expiry_market:6': 'The price jumped sharply while you were confirming — your payout would be well below the quote. Refresh and try again.',
  'expiry_market:7': 'The price snapshot didn’t match — refresh the quote and retry.',
  'expiry_market:8': 'The “price to beat” isn’t ready for this market yet.',
  'expiry_market:9': 'The “price to beat” timing didn’t line up — try again shortly.',
  'expiry_market:10': 'Can’t open and close in the same instant — wait a moment and retry.',
  // expiry_cash (per-market exposure backing)
  'expiry_cash:0': 'This market is at capacity right now — try the next expiry, or a smaller bet.',
  // order (id encoding — quantities must be whole $0.01 lots)
  'order:4': 'The position size didn’t land on the protocol’s size grid. Refresh and retry.',
  // strike_exposure_config (mint admission)
  'strike_exposure_config:0': 'This trade would open already at its knockout level — lower the leverage.',
  'strike_exposure_config:1': 'The odds moved outside the tradeable 1%–99% band. Pick a level nearer the current price.',
  'strike_exposure_config:4': 'Bets need at least a $1 stake (before fees). Add a little and try again.',
  'strike_exposure_config:5': 'Leverage can’t be below 1×.',
  'strike_exposure_config:6': 'That leverage is more than this market allows right now. Lower it and retry.',
  // strike_exposure (mint/close terms — codes from strike_exposure.move, 8-06 source)
  'strike_exposure:0': 'This position has less open than you’re trying to close. Refresh your positions and try again.',
  'strike_exposure:1': 'That price level isn’t on this market’s grid. Pick a level nearer the current price.',
  'strike_exposure:4': 'This position’s data changed while you were confirming. Refresh and retry.',
  'strike_exposure:5': 'This size is below the market’s minimum. Increase it a little and try again.',
  'strike_exposure:6': 'This position can’t be closed that way. Refresh your positions and retry.',
  'strike_exposure:7': 'Market data isn’t ready for this market yet. Try again in a second.',
  // account
  'account:0': 'This account belongs to a different wallet. Reconnect the one that created it.',
  'account:1': 'Not enough balance in your account — deposit a bit more DUSDC first.',
  'account:2': 'Couldn’t authorize with your wallet. Reconnect and retry.',
  // predict_account (per-account position registry)
  'predict_account:0': 'This position already exists.',
  'predict_account:1': 'This position is already claimed or closed. Refresh your positions.',
  'predict_account:2': 'This position doesn’t have that much left to claim. Refresh your positions.',
  'predict_account:3': 'This market still has open positions to close first.',
  // pricing
  'pricing:4': 'Market data is briefly stale. Try again in a second.',
  'pricing:6': 'The spot price feed is momentarily unavailable. Try again shortly.',
  'pricing:9': 'This market just expired. Pick another one.',
  'pricing:10': 'Market volatility data is briefly stale. Try again in a second.',
  // plp (vault)
  'plp:4': 'The vault isn’t bootstrapped yet.',
  'plp:5': 'The vault price hit a safety floor — LP actions are paused for a moment.',
  'plp:6': 'The vault price hit a safety ceiling — LP actions are paused for a moment.',
  'plp:11': 'That market hasn’t settled yet.',
};

export function humanizeV2Error(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');
  if (/MoveAbort|abort code/i.test(msg)) {
    const mod = msg.match(/0x[0-9a-f]+::([a-z_]+)::/i)?.[1] ?? msg.match(/::([a-z_]+)::[a-z_]+'/)?.[1];
    const code = msg.match(/abort code:?\s*(\d+)/i)?.[1];
    if (mod && code) {
      return V2_ABORTS[`${mod}:${code}`] ?? `On-chain check failed (${mod} #${code}).`;
    }
    return 'The protocol rejected this transaction.';
  }
  // A VM runtime error (overflow/underflow/index), not an assert — e.g. redeeming a
  // position that's already settled or claimed underflows the market's payout liability.
  // Don't leak the raw VM string; point the user at the fix.
  if (/MovePrimitiveRuntimeError|RuntimeError/i.test(msg)) {
    return 'This position looks already settled or claimed. Refresh your positions and try again.';
  }
  // Non-abort (wallet / session / network) — defer to the shared decoder.
  return humanizeWalletError(raw);
}

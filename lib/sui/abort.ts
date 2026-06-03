/**
 * lib/sui/abort.ts — turn raw Sui errors (MoveAbort strings, wallet messages)
 * into plain-language text for the trader.
 *
 * Move abort codes are confirmed from the predict-testnet-4-16 source. We parse
 * the failing `module` + `abort code` out of the error string and map them.
 */

const ABORT_MESSAGES: Record<string, string> = {
  // pricing_config: EFairPriceAlreadySettled — fair price hit exactly 0% or 100%.
  'pricing_config:1':
    'That strike is too far from the current price to trade. The market only quotes strikes near spot — pick one closer to the forward.',
  // oracle_config: key/grid/liveness checks.
  'oracle_config:1': 'This market just expired or refreshed — click a node on the surface again.',
  'oracle_config:2': 'That strike isn’t on the market’s grid. Use the − / + stepper to land on a valid strike.',
  'oracle_config:3': 'This market has already settled. Pick a different expiry.',
  'oracle_config:4': 'This market has expired and is awaiting settlement. Pick another expiry.',
  'oracle_config:5': 'This market isn’t active yet. Pick another expiry.',
  'oracle_config:6': 'Market data is stale (no recent oracle update). Try again in a moment.',
  // predict: trading + bounds.
  'predict:0': 'Trading is currently paused by the protocol.',
  'predict:1': 'This manager belongs to a different wallet account. Reconnect the account that created it.',
  'predict:3': 'Quantity must be at least 1 contract.',
  'predict:7': 'Price is outside the tradeable 1%–99% range. Pick a strike closer to spot.',
  // predict_manager
  'predict_manager:0': 'Wrong wallet account for this manager.',
  'predict_manager:1': 'You don’t hold enough of this position to redeem that amount.',
};

export function humanizeError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');

  // Wallet-level outcomes first.
  if (/incorrect password|wrong password|invalid password|locked/i.test(msg))
    return 'Your wallet couldn’t unlock to sign (it reported an incorrect password / locked vault). Unlock Slush — or lock and re-unlock it — then try again. This is a wallet error, not the trade.';
  if (/reject|denied|cancell?ed/i.test(msg)) return 'Transaction cancelled in the wallet.';
  if (/closed the wallet window|window closed|popup/i.test(msg))
    return 'Wallet window closed before the response came back — if you approved, it may still have gone through.';
  if (/insufficient/i.test(msg) && /gas|sui/i.test(msg))
    return 'Not enough SUI for gas. Add a little testnet SUI to this wallet.';
  if (/getaddrinfo|fetch failed|ENOTFOUND|network/i.test(msg))
    return 'Network hiccup reaching the chain. Check your connection and retry.';

  // Move aborts: pull module + code out of the standard message format.
  if (/MoveAbort|abort code/i.test(msg)) {
    const mod = msg.match(/0x[0-9a-f]+::([a-z_]+)::/i)?.[1] ?? msg.match(/::([a-z_]+)::[a-z_]+'/)?.[1];
    const code = msg.match(/abort code:?\s*(\d+)/i)?.[1];
    if (mod && code) {
      const mapped = ABORT_MESSAGES[`${mod}:${code}`];
      if (mapped) return mapped;
      return `On-chain check failed (${mod} #${code}).`;
    }
    return 'The protocol rejected this transaction.';
  }

  return msg || 'Something went wrong.';
}

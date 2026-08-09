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

/** Friendly, action-oriented copy for an expired Google / zkLogin sign-in. */
export const SESSION_EXPIRED_MESSAGE =
  'Your Google sign-in has expired. Click “Sign in with Google” again to refresh it, then retry your trade.';

/**
 * True when an error means the Enoki (Google / zkLogin) session has lapsed.
 *
 * A zkLogin session is time-boxed (it expires with its `maxEpoch`). Once it does,
 * the Enoki wallet silently tries to re-authenticate via a popup on the next
 * `signTransaction`, so the failure surfaces as one of these internal signing
 * errors — never a clear "you're logged out". We match the unambiguous ones here;
 * the ambiguous popup-closed/blocked case is disambiguated at the call site, where
 * we know the wallet is gasless (see `runTx`).
 */
export function isSessionExpired(raw: unknown): boolean {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');
  return /Failed to retrieve an active session|Native signer not found in store|Start of sign-in flow could not be found|Missing ID Token/i.test(
    msg,
  );
}

/**
 * True when a failure means the payer's gas coin (SUI) couldn't cover the network
 * fee. Two shapes reach us: a wallet's own "insufficient gas" text, and the node's
 * input-object rejection ("Balance of gas object … is lower than the needed amount:
 * 30000000") — the one a low-gas SESSION key hits, because a session tx reserves a
 * fixed budget and pays from its own SUI. Both mean the same thing to the trader:
 * add a little SUI. Matched in one place so wallet + session paths label it the same.
 */
export function isInsufficientGas(raw: unknown): boolean {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');
  return (
    (/insufficient/i.test(msg) && /\bgas\b|\bsui\b/i.test(msg)) ||
    /balance of gas object[\s\S]*lower than the needed amount/i.test(msg) ||
    /GasBalanceTooLow|InsufficientGas|No valid gas coins|Unable to select.*gas coin/i.test(msg)
  );
}

export function humanizeError(raw: unknown): string {
  const msg = raw instanceof Error ? raw.message : String(raw ?? '');

  // An expired Google / zkLogin session, before the generic popup/reject checks
  // below would otherwise mis-label it as a wallet-window error.
  if (isSessionExpired(raw)) return SESSION_EXPIRED_MESSAGE;

  // Wallet-level outcomes first.
  if (/incorrect password|wrong password|invalid password|locked/i.test(msg))
    return 'Your wallet couldn’t unlock to sign (it reported an incorrect password / locked vault). Unlock Slush — or lock and re-unlock it — then try again. This is a wallet error, not the trade.';
  if (/reject|denied|cancell?ed/i.test(msg)) return 'Transaction cancelled in the wallet.';
  if (/closed the wallet window|window closed|popup/i.test(msg))
    return 'Wallet window closed before the response came back — if you approved, it may still have gone through.';
  // Both the wallet's own "insufficient gas" and the node's raw "Balance of gas
  // object … lower than the needed amount" land here. Session callers rephrase this
  // toward the top-up (see runSessionTx); the plain wallet copy is the fallback.
  if (isInsufficientGas(raw))
    return 'Not enough SUI to cover the network fee in this wallet. Add a little testnet SUI, then try again.';
  if (/getaddrinfo|fetch failed|ENOTFOUND|network/i.test(msg))
    return 'Network hiccup reaching the chain. Check your connection and retry.';
  if (/Enoki API failed|sponsor failed|sponsorship/i.test(msg)) {
    // A rejected move-call target is a CONFIGURATION problem (the sponsor's
    // allowlist in /api/sponsor and the Enoki portal must include every call in
    // the PTB) — retrying will never clear it, so don't pretend it will.
    if (/disallow|not allowed|allowlist|allowed.*(target|move)|(target|move).*allow/i.test(msg))
      return 'The gasless service refused to sponsor this action — one of its contract calls isn’t on the sponsor allowlist. This is a configuration issue (not a passing glitch); retrying won’t help.';
    // A 5xx from Enoki is THEIR infrastructure failing (seen live 2026-07-08
    // when their testnet execute endpoint 502'd) — not the user's setup.
    if (/status: 5\d\d/.test(msg))
      return 'The gasless service is having an outage on its side right now — your setup and wallet are fine. Try again in a few minutes, or connect a regular wallet (it pays its own gas and skips the gasless service entirely).';
    return 'The gasless service briefly rejected the request (it can expire while signing). Please try again — this almost always clears on a retry.';
  }

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

/**
 * config/starter-grant.ts — the app-run "starter grant" (one-click drip faucet).
 *
 * Gas is already sponsored (Enoki), so the only thing between a fresh zkLogin
 * wallet and its first trade is the trading asset. Instead of sending new users
 * to an external faucet form, an app-controlled treasury wallet drips a small,
 * fixed amount of DUSDC straight to their wallet — see /api/starter-grant.
 *
 * Browser-safe values ONLY. The treasury private key and the authoritative grant
 * amount live server-side (STARTER_GRANT_* env, read in the route). The values
 * here are display/visibility only, so the button can never move real funds on
 * its own — it just asks the server, which enforces every cap.
 */

/** Default grant size: 2 DUSDC (@6dec). The server reads STARTER_GRANT_BASE and
 *  falls back to this; the client uses it only to label the button. Keep both in
 *  sync via env if you change it. */
export const STARTER_GRANT_BASE_DEFAULT = 2_000_000n;

/** Below this wallet DUSDC balance we treat a user as "needs funding" and offer
 *  the grant / faucet (1 DUSDC @6dec). The server re-checks this before paying. */
export const STARTER_GRANT_BALANCE_CEILING = 1_000_000n;

export const starterGrant = {
  /** Show the one-click grant button. Operator turns this on (=1) AFTER setting
   *  the treasury key server-side; until then the UI keeps the faucet link. */
  enabled: process.env.NEXT_PUBLIC_STARTER_GRANT_ENABLED === '1',
  /** Display amount for the button label (base units, @6dec). */
  displayBase: BigInt(
    process.env.NEXT_PUBLIC_STARTER_GRANT_BASE ?? STARTER_GRANT_BASE_DEFAULT.toString(),
  ),
} as const;

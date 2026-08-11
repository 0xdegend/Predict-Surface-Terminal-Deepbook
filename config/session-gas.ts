/**
 * config/session-gas.ts — the app-run SUI drip that funds a delegated-session key's
 * gas, so BOTH Google (gasless/zkLogin) and Slush users get the fast, popup-less,
 * one-call session trade path without having to hold or spend their own SUI.
 *
 * A session key signs its own trades and pays its OWN gas in SUI (that is what lets
 * it skip the wallet popup AND the Enoki sponsor round-trips — the lowest-latency
 * submit). Google users hold no SUI at all, and we would rather Slush users not spend
 * theirs either, so a small fixed amount is dripped from the app treasury straight to
 * the session key when instant trading is turned on. See /api/session-gas.
 *
 * Browser-safe values ONLY. The treasury key + authoritative amounts live server-side
 * (SESSION_GAS_* env, read in the route). These are display / gating hints so the
 * client can decide whether to attempt a drip vs. fall back to owner-funded gas.
 */

/** Target gas to put on a session key (MIST, @9dec). At ~a few thousandths of a SUI per
 *  trade, 0.1 SUI is many trades of runway. Keep in sync with DEFAULT_SESSION_GAS_FUNDING_BASE
 *  in lib/sui/v2/session.ts (the owner-funded fallback tops up to the same target). */
export const SESSION_GAS_DRIP_BASE_DEFAULT = 100_000_000n;

/** Skip the drip when the session key already holds at least this much SUI (MIST) —
 *  a re-arm after expiry usually has leftover gas and needs nothing. Default 0.06 SUI. */
export const SESSION_GAS_DRIP_CEILING_DEFAULT = 60_000_000n;

export const sessionGasDrip = {
  /** Attempt the treasury drip. Operator turns this on (=1) AFTER funding the
   *  treasury with SUI server-side. Off => Slush uses owner-funded gas and Google
   *  sessions stay disabled (a Google key can't self-fund without the drip). */
  enabled: process.env.NEXT_PUBLIC_SESSION_GAS_DRIP_ENABLED === '1',
} as const;

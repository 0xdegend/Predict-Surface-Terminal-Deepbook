/**
 * lib/wallet-kind.ts — how a user signed in, for admin wallet-mix analytics.
 *
 * Client-safe (no server or wallet-SDK imports) so both the browser beacon and the
 * server store/route can share the union. "google" = an Enoki zkLogin (Sign in with
 * Google) account; "slush" = the Slush wallet; "other" = any other connected wallet.
 */
export type WalletKind = 'google' | 'slush' | 'other';

export const WALLET_KINDS: readonly WalletKind[] = ['google', 'slush', 'other'] as const;

export function isWalletKind(v: unknown): v is WalletKind {
  return typeof v === 'string' && (WALLET_KINDS as readonly string[]).includes(v);
}

export const WALLET_KIND_LABEL: Record<WalletKind, string> = {
  google: 'Google',
  slush: 'Slush',
  other: 'Other',
};

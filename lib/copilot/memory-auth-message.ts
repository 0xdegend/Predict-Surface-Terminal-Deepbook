/**
 * lib/copilot/memory-auth-message.ts — the exact text a trader signs to prove they
 * control a wallet before Kelly will read or write that wallet's memories.
 *
 * SHARED + PURE so the client (which asks the wallet to sign it) and the server (which
 * rebuilds it from the same fields to verify the signature) produce byte-identical text.
 * The server rebuilds the message from {address, nonce, issuedAt} rather than trusting a
 * raw string from the client, so the signed content is always our template, never
 * attacker-chosen. Keep this deterministic: no locale formatting, no trailing whitespace.
 *
 * This is a plain sign-in message. It never authorizes a transaction or moves funds.
 */

/** How long a signed sign-in stays valid to exchange for a session (server enforces). */
export const MEMORY_SIGNIN_TTL_MS = 5 * 60_000;

export interface SignInFields {
  /** The Sui address being proven (0x-prefixed, lowercased by the caller). */
  address: string;
  /** One-time server-issued nonce (hex), so a captured signature can't be replayed. */
  nonce: string;
  /** ISO-8601 timestamp the client stamped when it asked for the signature. */
  issuedAt: string;
}

/** Build the human-readable sign-in message. Must stay byte-stable across client + server. */
export function buildSignInMessage({ address, nonce, issuedAt }: SignInFields): string {
  return [
    "Skew: sign in to Kelly's memory.",
    '',
    'This lets Kelly remember your preferences across sessions. It does not move funds or approve any transaction.',
    '',
    `Wallet: ${address}`,
    `Nonce: ${nonce}`,
    `Issued: ${issuedAt}`,
  ].join('\n');
}

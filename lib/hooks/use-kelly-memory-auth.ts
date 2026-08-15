'use client';

/**
 * useKellyMemoryAuth — the client half of Kelly's memory sign-in gate.
 *
 * Kelly's memory API (recall/remember) requires a wallet session cookie. This hook tracks
 * whether the connected wallet has one, and mints one on demand with a single personal-message
 * signature (never a transaction). The flow: GET a fresh nonce, ask the wallet to sign the exact
 * shared message (lib/copilot/memory-auth-message), POST the signature to verify, and the server
 * sets an HttpOnly cookie. After that, recall/remember (and passive continuity + auto-remember)
 * ride the cookie with no further prompts until it expires.
 *
 *   - `signedIn`      — true when the CONNECTED wallet already has a valid session.
 *   - `configured`    — false when the server has no signing secret (memory effectively off).
 *   - `ensureSignedIn()` — resolves true once the connected wallet is signed in, prompting one
 *                          signature if needed; false if there's no wallet, it's unconfigured,
 *                          or the trader declines. Safe to call before any explicit remember/recall.
 *
 * Passive continuity + auto-remember DON'T call ensureSignedIn (they never prompt) — they act
 * only when `signedIn` is already true. The explicit "remember …" / "what do you remember"
 * paths call ensureSignedIn so the trader opts in once.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react';
import { getMemorySession, verifyMemorySignIn } from '@/lib/copilot/memory-client';
import { buildSignInMessage } from '@/lib/copilot/memory-auth-message';

export interface KellyMemoryAuth {
  /** The address that currently holds a valid session cookie (lowercased), or null. */
  authedAddress: string | null;
  /** True when the connected wallet is the one holding the session. */
  signedIn: boolean;
  /** False when the server has no signing secret configured (memory off). */
  configured: boolean;
  /** Re-read the session status (e.g. after a wallet change). */
  refresh: () => void;
  /** Ensure the connected wallet is signed in, prompting one signature if needed. */
  ensureSignedIn: () => Promise<boolean>;
}

const norm = (a: string | undefined | null): string | null => (a ? a.toLowerCase() : null);

export function useKellyMemoryAuth(): KellyMemoryAuth {
  const account = useCurrentAccount();
  const dAppKit = useDAppKit();
  const address = norm(account?.address);

  const [authedAddress, setAuthedAddress] = useState<string | null>(null);
  const [configured, setConfigured] = useState(true);
  // Serialize sign-in attempts so a double-tap can't open two wallet prompts.
  const signingRef = useRef<Promise<boolean> | null>(null);

  const refresh = useCallback(() => {
    let cancelled = false;
    void (async () => {
      const s = await getMemorySession();
      if (cancelled) return;
      setConfigured(s.configured);
      setAuthedAddress(s.authed ? norm(s.address) : null);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Read the session on mount and whenever the connected wallet changes.
  useEffect(() => {
    const cancel = refresh();
    return cancel;
  }, [address, refresh]);

  const ensureSignedIn = useCallback(async (): Promise<boolean> => {
    if (!address) return false;
    if (authedAddress === address) return true;
    if (signingRef.current) return signingRef.current;

    const run = (async (): Promise<boolean> => {
      const session = await getMemorySession();
      setConfigured(session.configured);
      if (!session.configured || !session.nonce) return false;
      // Already good (cookie present for this wallet from a prior session).
      if (session.authed && norm(session.address) === address) {
        setAuthedAddress(address);
        return true;
      }
      const issuedAt = new Date().toISOString();
      const message = buildSignInMessage({ address, nonce: session.nonce, issuedAt });
      try {
        const { signature } = await dAppKit.signPersonalMessage({
          message: new TextEncoder().encode(message),
        });
        const proven = await verifyMemorySignIn({ address, nonce: session.nonce, issuedAt, signature });
        if (proven && norm(proven) === address) {
          setAuthedAddress(address);
          return true;
        }
        return false;
      } catch {
        // Trader declined the signature, or the wallet errored — not signed in.
        return false;
      }
    })();

    signingRef.current = run;
    try {
      return await run;
    } finally {
      signingRef.current = null;
    }
  }, [address, authedAddress, dAppKit]);

  return {
    authedAddress,
    signedIn: !!address && authedAddress === address,
    configured,
    refresh,
    ensureSignedIn,
  };
}

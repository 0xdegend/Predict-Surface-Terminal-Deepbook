'use client';

/**
 * WalletTracker — a silent beacon that records how the connected wallet signed in
 * (Google / Slush / Other) for the admin "Wallet mix" card. Renders nothing.
 *
 * Fires once per browser session per (address, kind): guarded by sessionStorage so a
 * reconnect or route change doesn't re-POST. Fire-and-forget with `keepalive` so it
 * survives a navigation. Reports only the public address + the sign-in category, never
 * any Google identity. Mounted globally inside the wallet provider (app/providers.tsx).
 */
import { useEffect } from 'react';
import { useWalletConnection } from '@mysten/dapp-kit-react';
import { isEnokiWallet } from '@mysten/enoki';
import type { WalletKind } from '@/lib/wallet-kind';

function classify(wallet: { name?: string } | null | undefined): WalletKind {
  if (!wallet) return 'other';
  // Enoki wraps the "Sign in with Google" zkLogin flow.
  if (isEnokiWallet(wallet as Parameters<typeof isEnokiWallet>[0])) return 'google';
  if (/slush/i.test(wallet.name ?? '')) return 'slush';
  return 'other';
}

export function WalletTracker() {
  const conn = useWalletConnection();
  const address = conn.isConnected ? conn.account?.address : undefined;
  const wallet = conn.wallet;

  useEffect(() => {
    if (!address || !wallet) return;
    const addr = address.toLowerCase();
    const kind = classify(wallet);
    const flag = `wt:${addr}:${kind}`;
    try {
      if (sessionStorage.getItem(flag)) return;
    } catch {
      // sessionStorage unavailable (private mode) → still send; server dedupes by set.
    }
    void fetch('/api/track/wallet', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ address: addr, kind }),
      keepalive: true,
    })
      .then(() => {
        try {
          sessionStorage.setItem(flag, '1');
        } catch {
          /* ignore */
        }
      })
      .catch(() => {
        /* fire-and-forget */
      });
  }, [address, wallet]);

  return null;
}

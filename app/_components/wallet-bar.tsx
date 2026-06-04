'use client';

import dynamic from 'next/dynamic';
import { useCurrentAccount, useCurrentNetwork } from '@mysten/dapp-kit-react';
import { shortId } from '@/lib/format';

// The dapp-kit /ui bundle registers web components against `window` at import
// time, so it must not be evaluated during SSR. Load it client-only.
const ConnectButton = dynamic(
  () => import('@mysten/dapp-kit-react/ui').then((m) => m.ConnectButton),
  { ssr: false, loading: () => <ConnectButtonSkeleton /> },
);

function ConnectButtonSkeleton() {
  return (
    <span className="inline-block h-8 w-28 animate-pulse rounded border border-white/10 bg-white/[0.03]" />
  );
}

/** Network pill + wallet connect. Client-only (wallet detection is browser-only). */
export function WalletBar() {
  const account = useCurrentAccount();
  const network = useCurrentNetwork();

  const isTestnet = /test|dev|local/i.test(network);

  return (
    <div className="flex items-center gap-2.5">
      <span
        className={`hidden items-center gap-1.5 rounded-md border px-2 py-1 text-[10px] font-medium uppercase tracking-wider sm:inline-flex ${
          isTestnet
            ? 'border-[var(--warn-soft)] bg-[var(--warn-soft)] text-warn'
            : 'border-[var(--line)] text-text-2'
        }`}
      >
        <span className={`h-1.5 w-1.5 rounded-full ${isTestnet ? 'bg-warn' : 'bg-accent'}`} />
        {network}
      </span>
      {account && (
        <span className="chip hidden h-9 px-2.5 font-mono text-[11px] tabular-nums text-text-2 md:inline-flex">
          {shortId(account.address)}
        </span>
      )}
      <ConnectButton />
    </div>
  );
}

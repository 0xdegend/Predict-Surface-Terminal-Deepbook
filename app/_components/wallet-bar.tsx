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

  return (
    <div className="flex items-center gap-3">
      <span className="inline-flex items-center gap-1.5 rounded border border-white/10 px-2 py-1 text-[11px] uppercase tracking-wider text-[#8B9099]">
        <span className="h-1.5 w-1.5 rounded-full bg-teal-400/80" />
        {network}
      </span>
      {account && (
        <span className="font-mono text-[11px] text-[#8B9099] tabular-nums">
          {shortId(account.address)}
        </span>
      )}
      <ConnectButton />
    </div>
  );
}

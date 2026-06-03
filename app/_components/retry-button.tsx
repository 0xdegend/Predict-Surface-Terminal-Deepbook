'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Re-runs the server component fetch. Server snapshots can fail on a transient
 * network/DNS blip (getaddrinfo ENOTFOUND) — this turns the dead-end error panel
 * into one-click recovery instead of a manual browser refresh.
 */
export function RetryButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  return (
    <button
      onClick={() => {
        setBusy(true);
        router.refresh();
        // router.refresh resolves async; clear after a beat so the label resets.
        setTimeout(() => setBusy(false), 2000);
      }}
      disabled={busy}
      className="mt-3 rounded border border-line-strong px-3 py-1 font-mono text-[11px] text-text-1 hover:bg-white/5 disabled:opacity-50"
    >
      {busy ? 'retrying…' : 'Retry'}
    </button>
  );
}

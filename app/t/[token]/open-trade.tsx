'use client';

/**
 * OpenSharedTrade — the CTA on the shared-trade landing. Applies the decoded recipe
 * to the trade store (re-resolved to a live market) and routes to /v2 with the ticket
 * pre-filled. It only pre-fills; the trader connects + confirms the live quote on the
 * ticket. If every market of the recipe's shape has rolled over, it offers the live
 * markets instead of dead-ending.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useV2OpenSharedTrade } from '@/lib/hooks/use-v2-open-shared-trade';
import type { TradeRecipe } from '@/lib/share/trade-link';

/** Fire-and-forget attribution ping; never blocks or throws into the flow. */
function beacon(kind: 'open' | 'convert', ref?: string) {
  try {
    fetch('/api/share/event', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ kind, ref }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignore */
  }
}

export function OpenSharedTrade({ recipe }: { recipe: TradeRecipe }) {
  const { openSharedTrade } = useV2OpenSharedTrade();
  const [state, setState] = useState<'idle' | 'loading' | 'nomarket'>('idle');

  // Landing viewed on a JS-running client → a real "open" (bots don't run this).
  useEffect(() => {
    beacon('open', recipe.ref);
  }, [recipe.ref]);

  async function go() {
    setState('loading');
    const res = await openSharedTrade(recipe); // routes to /v2 on success
    if (res.ok) beacon('convert', recipe.ref);
    else setState('nomarket');
  }

  if (state === 'nomarket') {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-[12px] text-text-3">
          These markets have rolled over since the link was made. New ones open every minute.
        </p>
        <Link
          href="/v2"
          className="w-full rounded-lg border border-line py-3 text-center text-[13px] font-medium text-text-1 transition-colors hover:border-white/20"
        >
          Browse live markets
        </Link>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={go}
      disabled={state === 'loading'}
      className="w-full rounded-lg bg-up py-3 text-[13px] font-semibold text-bg-0 transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      {state === 'loading' ? 'Opening…' : 'Open this trade'}
    </button>
  );
}

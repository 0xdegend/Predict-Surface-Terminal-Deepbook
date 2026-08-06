'use client';

/**
 * OpenSharedTrade — the CTA on the shared-trade landing. Applies the decoded recipe to
 * the trade store (re-resolved to a live market) and routes to /v2 with the ticket
 * pre-filled. It only pre-fills; the trader connects + confirms the live quote on the
 * ticket.
 *
 * On mount it also probes whether a live market of this shape is actually open right now
 * (with enough runway to place). If none is, it shows a "this market has closed" state
 * immediately, so the recipient learns it on landing instead of after a tap. The tap
 * re-resolves authoritatively, so a market that rolls between the probe and the tap is
 * still caught by go().
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useV2OpenSharedTrade, checkSharedTradeAvailable } from '@/lib/hooks/use-v2-open-shared-trade';
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
  const [state, setState] = useState<'checking' | 'idle' | 'loading' | 'nomarket'>('checking');

  // Landing viewed on a JS-running client → a real "open" (bots don't run this). Also
  // probe availability so we can tell them upfront if the market has rolled over.
  useEffect(() => {
    let alive = true;
    beacon('open', recipe.ref);
    checkSharedTradeAvailable(recipe).then((ok) => {
      if (alive) setState(ok ? 'idle' : 'nomarket');
    });
    return () => {
      alive = false;
    };
  }, [recipe]);

  async function go() {
    setState('loading');
    const res = await openSharedTrade(recipe); // routes to /v2 on success
    if (res.ok) beacon('convert', recipe.ref);
    else setState('nomarket');
  }

  if (state === 'nomarket') {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-lg border border-line bg-bg-0 px-4 py-3 text-center">
          <p className="font-mono text-[11px] uppercase tracking-wider text-down">This market has closed</p>
          <p className="mt-1.5 font-sans text-[12px] leading-relaxed text-text-2">
            The markets for this trade have rolled over since the link was shared. Fresh ones open every minute, so
            try again in a moment or browse what is live now.
          </p>
        </div>
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
      disabled={state !== 'idle'}
      className="w-full rounded-lg bg-up py-3 text-[13px] font-semibold text-bg-0 transition-opacity hover:opacity-90 disabled:opacity-60"
    >
      {state === 'checking' ? 'Checking market…' : state === 'loading' ? 'Opening…' : 'Open this trade'}
    </button>
  );
}

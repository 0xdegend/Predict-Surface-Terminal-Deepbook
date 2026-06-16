'use client';

/**
 * BalancePill — the trader's wallet DUSDC balance, shown in the top chrome and
 * linking to the Portfolio. Lifted out of the trade ticket so the right rail has
 * more room (the ticket no longer carries an account strip). Uses the SAME query
 * key as usePredictAccount (`qk.dusdcBalance`), so TanStack dedupes the fetch and
 * the figure stays in lockstep with the ticket. Hidden on phones — there the
 * balance lives one tap away under Portfolio in the bottom dock.
 */
import Link from 'next/link';
import { useCurrentAccount, useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/api/client';
import { predictConfig } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';
import { useMounted } from '@/lib/hooks/use-mounted';

export function BalancePill() {
  const account = useCurrentAccount();
  const client = useCurrentClient();
  const mounted = useMounted();
  const owner = account?.address ?? null;
  const sym = predictConfig.quote.symbol;

  const { data } = useQuery({
    queryKey: qk.dusdcBalance(owner ?? ''),
    queryFn: async () => {
      const r = await client.core.getBalance({
        owner: owner!,
        coinType: predictConfig.quote.coinType,
      });
      return BigInt(r.balance.balance);
    },
    enabled: !!owner,
    refetchInterval: 10_000,
  });

  // SSR has no wallet — render nothing until mounted (and only when connected)
  // so the server/first-client paint match and the header doesn't shift.
  if (!mounted || !owner) return null;

  // Rendered as the leading SEGMENT of the unified account cluster (see
  // WalletBar) — borderless; the cluster shell owns the border + hairline
  // dividers. Hidden below md, where the balance lives under Portfolio.
  return (
    <Link
      href="/portfolio"
      title="View portfolio"
      aria-label={`Balance ${data === undefined ? '' : fmtQuote(fromQuote(data))} ${sym} — view portfolio`}
      className="hidden h-full items-center gap-1.5 px-3 font-mono text-[11px] tabular-nums text-text-1 transition-colors hover:bg-white/[0.04] md:inline-flex"
    >
      <span className="text-text-1">{data === undefined ? '…' : fmtQuote(fromQuote(data))}</span>
      <span className="text-text-3">{sym}</span>
    </Link>
  );
}

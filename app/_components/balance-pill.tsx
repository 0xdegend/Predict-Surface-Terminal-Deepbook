'use client';

/**
 * BalancePill — the trader's DUSDC balance in the top chrome, linking to the Portfolio.
 *
 * On the v2 terminal this shows the TOTAL a trader can actually bet with — trading
 * account + wallet — because the mint auto-deposits any wallet shortfall, so the two
 * buckets together are the real spendable figure. Showing only the wallet coin (the old
 * behaviour, still used on the dead legacy chrome) undercounts an active trader, whose
 * payouts settle into the trading account: they'd glance at the header and think that was
 * all they had. Hovering the pill reveals the split (trading account vs wallet) so the
 * detail is one motion away; the full breakdown also lives on the Portfolio page the pill
 * links to. Hidden on phones — there the balance lives one tap away under Portfolio.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { useV2ReadClient } from '@/lib/sui/grpc';
import { useQuery } from '@tanstack/react-query';
import { qk } from '@/lib/api/client';
import { predictConfig, predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';
import { useMounted } from '@/lib/hooks/use-mounted';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';

// useLayoutEffect on the client (position the hover card before paint, no flicker),
// useEffect on the server (avoids the SSR "does nothing" warning). Mirrors InfoTip.
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const PILL_CLASS =
  'hidden h-full items-center gap-1.5 px-3 font-mono text-[11px] tabular-nums text-text-1 transition-colors hover:bg-white/[0.04] md:inline-flex';

export function BalancePill() {
  const pathname = usePathname();
  const isV2 = pathname?.startsWith('/v2') ?? false;
  // v2 shows the spendable TOTAL with a hover breakdown; legacy keeps the wallet-only
  // figure. Rendering the v2 variant only on /v2 means its account queries never spin
  // up on the legacy chrome (and both variants keep hooks unconditional internally).
  return isV2 ? <V2TotalPill /> : <WalletOnlyPill />;
}

/* ------------------------- v2: total + hover breakdown ------------------------- */

function V2TotalPill() {
  const acct = usePredictAccountV2();
  const mounted = useMounted();
  const sym = predictV2Config.quote.symbol;
  const anchorRef = useRef<HTMLAnchorElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  const WIDTH = 224;
  const MARGIN = 8;
  const GAP = 8;

  useIsoLayoutEffect(() => {
    if (!open || !anchorRef.current) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      // Right-align the card under the pill, clamped to stay fully on screen.
      const left = Math.max(MARGIN, Math.min(r.right - WIDTH, window.innerWidth - WIDTH - MARGIN));
      setPos({ left, top: r.bottom + GAP });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  if (!mounted || !acct.owner) return null;

  const acctBase = acct.balanceBase; // trading account DUSDC
  const walletBase = acct.walletDusdcBase; // wallet DUSDC — undefined while the first read is in flight
  const ready = walletBase !== undefined;
  const totalBase = acctBase + (walletBase ?? 0n);

  return (
    <>
      <Link
        ref={anchorRef}
        href="/v2/portfolio"
        title="View portfolio"
        aria-label={`Total balance ${ready ? fmtQuote(fromQuote(totalBase)) : ''} ${sym}, trading account plus wallet — view portfolio`}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className={PILL_CLASS}
      >
        <span className="text-text-1">{ready ? fmtQuote(fromQuote(totalBase)) : '…'}</span>
        <span className="text-text-3">{sym}</span>
      </Link>

      {open &&
        ready &&
        pos &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            role="tooltip"
            style={{ position: 'fixed', left: pos.left, top: pos.top, width: WIDTH }}
            className="glass pointer-events-none z-100 flex flex-col rounded-lg p-3 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.8)]"
          >
            <span className="mb-2 text-[9px] font-medium uppercase tracking-wider text-text-3">Your {sym}</span>
            <BreakdownRow label="Trading account" base={acctBase} sym={sym} />
            <BreakdownRow label="Wallet" base={walletBase} sym={sym} />
            <span className="my-2 h-px bg-white/10" />
            <BreakdownRow label="Total" base={totalBase} sym={sym} strong />
          </div>,
          document.body,
        )}
    </>
  );
}

function BreakdownRow({
  label,
  base,
  sym,
  strong = false,
}: {
  label: string;
  base: bigint;
  sym: string;
  strong?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className={`text-[11px] ${strong ? 'text-text-1' : 'text-text-3'}`}>{label}</span>
      <span className={`font-mono text-[11px] tabular-nums ${strong ? 'font-medium text-text-1' : 'text-text-2'}`}>
        {fmtQuote(fromQuote(base))} <span className="text-text-3">{sym}</span>
      </span>
    </div>
  );
}

/* ---------------------------- legacy: wallet only ---------------------------- */

/** The original wallet-DUSDC pill, kept for the legacy chrome (6-24). Uses the SAME
 *  query key as usePredictAccount (`qk.dusdcBalance`), so TanStack dedupes the fetch. */
function WalletOnlyPill() {
  const account = useCurrentAccount();
  const client = useV2ReadClient();
  const mounted = useMounted();
  const owner = account?.address ?? null;
  const sym = predictConfig.quote.symbol;

  const { data } = useQuery({
    queryKey: qk.dusdcBalance(owner ?? ''),
    queryFn: async () => {
      const r = await client.core.getBalance({ owner: owner!, coinType: predictConfig.quote.coinType });
      return BigInt(r.balance.balance);
    },
    enabled: !!owner,
    refetchInterval: 10_000,
  });

  if (!mounted || !owner) return null;

  return (
    <Link
      href="/portfolio"
      title="View portfolio"
      aria-label={`Balance ${data === undefined ? '' : fmtQuote(fromQuote(data))} ${sym} — view portfolio`}
      className={PILL_CLASS}
    >
      <span className="text-text-1">{data === undefined ? '…' : fmtQuote(fromQuote(data))}</span>
      <span className="text-text-3">{sym}</span>
    </Link>
  );
}

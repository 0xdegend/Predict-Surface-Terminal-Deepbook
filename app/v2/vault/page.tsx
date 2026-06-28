/**
 * /v2/vault — provide liquidity to the new-deployment PLP vault (async queue).
 * Server shell; the panel is a client leaf that reads vault state + the user's
 * account and queues supply/withdraw requests.
 */
import Link from 'next/link';
import { V2VaultPanel } from '@/app/_components/v2/vault-panel';

export const dynamic = 'force-dynamic';

export default function V2VaultPage() {
  return (
    <main className="mx-auto max-w-md px-4 py-8 sm:px-6">
      <header className="mb-6">
        <Link href="/v2" className="text-[11px] text-text-3 hover:text-text-1">← Latest markets</Link>
        <h1 className="mt-2 text-[22px] font-semibold tracking-tight text-text-1">Liquidity vault</h1>
        <p className="mt-1 text-[13px] leading-relaxed text-text-2">
          Back the protocol and earn its trading edge. Liquidity moves through a queue
          and fills at each vault update.
        </p>
      </header>
      <V2VaultPanel />
    </main>
  );
}

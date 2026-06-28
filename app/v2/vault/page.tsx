/**
 * /v2/vault — Vault & Risk for the new deployment. Two columns: the read-side
 * overview (real metrics + liquidity composition + queue) and the async-LP
 * action panel. Server shell; both panels are client leaves.
 */
import { V2VaultOverview } from '@/app/_components/v2/vault-overview';
import { V2VaultPanel } from '@/app/_components/v2/vault-panel';

export const dynamic = 'force-dynamic';

export default function V2VaultPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="eyebrow mb-1">Latest</p>
        <h1 className="text-[22px] font-semibold tracking-tight text-text-1">Liquidity vault</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
          Back the protocol and earn its trading edge. Liquidity moves through a queue and fills
          at each vault update.
        </p>
      </header>
      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <V2VaultOverview />
        <V2VaultPanel />
      </div>
    </main>
  );
}

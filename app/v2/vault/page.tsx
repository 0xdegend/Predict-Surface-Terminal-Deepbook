import type { Metadata } from 'next';
import { LuLandmark } from 'react-icons/lu';
import { V2VaultTabs } from '@/app/_components/v2/vault-tabs';
import { V2VaultPanel } from '@/app/_components/v2/vault-panel';
import { V2VaultHedge } from '@/app/_components/v2/vault-hedge';

export const metadata: Metadata = {
  title: 'Vault',
  description:
    'Back the new Predict release and earn its trading edge. Deposits and withdrawals queue and fill at each vault update.',
};

export const dynamic = 'force-dynamic';

export default function V2VaultPage() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
      <header className="mb-5">
        <p className="eyebrow mb-1">Latest · Vault</p>
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuLandmark size={18} className="text-accent" />
          Liquidity vault
        </h1>
        <p className="mt-1 max-w-2xl text-[12px] text-text-3">
          Back the protocol and earn its trading edge.
        </p>
      </header>
      {/* grid-cols-1 (= minmax(0,1fr)) on mobile so the single column can't grow
          past the viewport — without it the Activity table's min-width blows the
          column out and pushes the tab bar off-screen. */}
      <div className="grid grid-cols-1 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Left: the pool split into Pool / Activity tabs so the secondary
            history + chart don't stretch the page (V2VaultTabs). */}
        <V2VaultTabs />
        {/* Right rail: deposit/withdraw, then optional crash protection — sits
            beside the pool so an LP can hedge the downside they just took on. */}
        <div className="flex flex-col gap-5">
          <V2VaultPanel />
          <V2VaultHedge />
        </div>
      </div>
    </main>
  );
}

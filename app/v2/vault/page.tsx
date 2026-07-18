import type { Metadata } from 'next';
import { LuLandmark } from 'react-icons/lu';
import { V2VaultOverview } from '@/app/_components/v2/vault-overview';
import { V2VaultPerformance } from '@/app/_components/v2/vault-performance';
import { V2VaultPanel } from '@/app/_components/v2/vault-panel';
import { V2VaultQueue } from '@/app/_components/v2/vault-queue';
import { V2VaultHedge } from '@/app/_components/v2/vault-hedge';

export const metadata: Metadata = {
  title: 'Vault',
  description:
    'Back the new Predict release and earn its trading edge — deposits and withdrawals queue and fill at each vault update.',
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
          Back the protocol and earn its trading edge. Money moves through a queue and fills at
          each vault update.
        </p>
      </header>
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <V2VaultOverview />
          {/* Price-per-share history from the indexer — shows LPs the pool is
              actually earning (server data; the overview stays on-chain). */}
          <V2VaultPerformance />
          {/* The queue sits under the pool metrics: it's the read-side answer to
              "where did my deposit go", and the only place a queued request can be
              cancelled before the keeper's flush fills it. */}
          <V2VaultQueue />
        </div>
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

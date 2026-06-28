/**
 * /v2/portfolio — the trader's account + open positions on the new deployment.
 * Server shell; the panels are client leaves (wallet/owner-driven).
 */
import { V2AccountPanel } from '@/app/_components/v2/account-panel';
import { V2PositionsPanel } from '@/app/_components/v2/positions-panel';

export const dynamic = 'force-dynamic';

export default function V2PortfolioPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="eyebrow mb-1">Latest</p>
        <h1 className="text-[22px] font-semibold tracking-tight text-text-1">Portfolio</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
          Your account balance and open positions on the new Predict release.
        </p>
      </header>
      <div className="grid gap-6 lg:grid-cols-2">
        <V2AccountPanel />
        <V2PositionsPanel />
      </div>
    </main>
  );
}

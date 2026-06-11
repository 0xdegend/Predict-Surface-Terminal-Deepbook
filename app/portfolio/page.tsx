import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { PortfolioPanel } from '../_components/positions/portfolio-panel';

export const metadata: Metadata = {
  title: 'Portfolio',
  description:
    'Your DeepBook Predict positions on Skew — live PnL marked to the current fair value, with one-click redeem for open and settled bets.',
};

// Wallet-specific account view. The data is client-only (needs the connected
// wallet), so this server route just renders the shared chrome + client panel.
export const dynamic = 'force-dynamic';

export default function PortfolioRoute() {
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="portfolio" />
      <main className="flex flex-1 flex-col">
        <PortfolioPanel serverNow={serverNow} />
      </main>
    </div>
  );
}

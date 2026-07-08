import type { Metadata } from 'next';
import { V2PortfolioPanel } from '@/app/_components/v2/portfolio-panel';

export const metadata: Metadata = {
  title: 'Portfolio',
  description:
    'Your account and open positions on the new Predict release — live balances, PnL, and one-click claim for settled bets.',
};

// Wallet-specific account view. The data is client-only (needs the connected
// wallet), so this server route just renders the client panel under the shared
// /v2 chrome from the layout.
export const dynamic = 'force-dynamic';

export default function V2PortfolioPage() {
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();
  return (
    <main className="flex flex-1 flex-col">
      <V2PortfolioPanel serverNow={serverNow} />
    </main>
  );
}

import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { PortfolioPanel } from '../_components/positions/portfolio-panel';

export const metadata: Metadata = {
  // A personal, wallet-specific view: there is nothing here to rank for, and it is
  // reachable only with a wallet connected, so indexing it has no upside. It also carries
  // the post-redeploy "move your balance" copy, which is the shape of page a search engine
  // is most likely to misread. /v2/admin already opts out for the same reason.
  robots: { index: false, follow: false },
  title: 'Portfolio',
  description:
    'Your DeepBook Predict positions on Skew: live PnL marked to the current fair value, with one-click redeem for open and settled bets.',
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

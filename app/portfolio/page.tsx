import { TopChrome } from '../_components/top-chrome';
import { PortfolioPanel } from '../_components/positions/portfolio-panel';

// Wallet-specific account view. The data is client-only (needs the connected
// wallet), so this server route just renders the shared chrome + client panel.
export const dynamic = 'force-dynamic';

export default function PortfolioRoute() {
  // eslint-disable-next-line react-hooks/purity
  const serverNow = Date.now();
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome phase="Phase 4 · portfolio" active="portfolio" />
      <main className="flex flex-1 flex-col">
        <PortfolioPanel serverNow={serverNow} />
      </main>
    </div>
  );
}

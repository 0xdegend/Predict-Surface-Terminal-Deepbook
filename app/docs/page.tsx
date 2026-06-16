import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { DocsPanel } from '../_components/docs/docs-panel';

export const metadata: Metadata = {
  title: 'Docs',
  description:
    'The Skew manual — how to read the volatility surface, mint binary and range predictions, manage positions, provide liquidity, and climb the ranks on DeepBook Predict.',
};

// Static reference content + a client scroll-spy nav; no wallet or data fetch.
export const dynamic = 'force-dynamic';

export default function DocsRoute() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="docs" />
      <main className="flex flex-1 flex-col">
        <DocsPanel />
      </main>
    </div>
  );
}

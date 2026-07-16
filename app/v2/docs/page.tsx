import type { Metadata } from 'next';
import { DocsPanel } from '@/app/_components/docs/docs-panel';

export const metadata: Metadata = {
  title: 'Docs',
  description:
    'The Skew manual — how to read the live price map, place Up/Down and range bets, cash out, add to the pool, and climb the ranks on DeepBook Predict.',
};

// Static reference content + a client scroll-spy nav; no wallet or data fetch.
// The v2 chrome/bottom-nav come from app/v2/layout.tsx, so unlike the legacy
// /docs route this page renders inside the Latest shell (its Docs nav links here).
export const dynamic = 'force-dynamic';

export default function V2DocsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <DocsPanel />
    </main>
  );
}

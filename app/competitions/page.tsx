import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { CompetitionsPanel } from '../_components/rewards/competitions-panel';

export const metadata: Metadata = {
  title: 'Competitions',
  description:
    'Skew Competitions — seasonal trading races where the top traders split a DUSDC prize pool. A preview of the competitive layer coming to the Skew terminal.',
};

// A self-contained showcase of the upcoming competitions system (the live
// countdown is the only client state) — renders the shared chrome + panel.
export const dynamic = 'force-dynamic';

export default function CompetitionsRoute() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="competitions" />
      <main className="flex flex-1 flex-col">
        <CompetitionsPanel />
      </main>
    </div>
  );
}

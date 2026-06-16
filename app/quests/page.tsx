import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { QuestsPanel } from '../_components/rewards/quests-panel';

export const metadata: Metadata = {
  title: 'Quests',
  description:
    'Skew Quests — complete trading milestones to earn DUSDC rewards. A preview of the gamified trading layer coming to the Skew terminal.',
};

// A self-contained showcase of the upcoming quests system — no wallet, no data
// fetch — so it just renders the shared chrome + client panel.
export const dynamic = 'force-dynamic';

export default function QuestsRoute() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="quests" />
      <main className="flex flex-1 flex-col">
        <QuestsPanel />
      </main>
    </div>
  );
}

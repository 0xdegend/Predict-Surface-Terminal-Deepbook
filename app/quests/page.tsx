import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { QuestsPanel } from '../_components/rewards/quests-panel';

export const metadata: Metadata = {
  title: 'Quests',
  description:
    'Skew Quests: complete trading milestones to earn Skew Points. Progress tracks live from your own on-chain trading record; rewards open soon.',
};

// A thin shell: the panel is a client component that reads the connected wallet's own
// record, so nothing about a trader is fetched or rendered on the server.
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

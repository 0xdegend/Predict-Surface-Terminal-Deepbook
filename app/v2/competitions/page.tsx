import type { Metadata } from 'next';
import { CompetitionsPanel } from '@/app/_components/rewards/competitions-panel';

export const metadata: Metadata = {
  title: 'Competitions',
  description:
    'Skew Competitions — seasonal trading races where the top traders split a DUSDC prize pool. A preview of the competitive layer coming to the Skew terminal.',
};

// Same self-contained showcase as legacy /competitions — the v2 layout provides
// the chrome, and the cross-link stays inside the Latest shell.
export const dynamic = 'force-dynamic';

export default function V2CompetitionsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <CompetitionsPanel questsHref="/v2/quests" />
    </main>
  );
}

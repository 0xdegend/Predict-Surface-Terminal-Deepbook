import type { Metadata } from 'next';
import { QuestsPanel } from '@/app/_components/rewards/quests-panel';

export const metadata: Metadata = {
  title: 'Quests',
  description:
    'Skew Quests — complete trading milestones to earn DUSDC rewards. A preview of the gamified trading layer coming to the Skew terminal.',
};

// Same self-contained showcase as legacy /quests — the v2 layout provides the
// chrome, and the cross-link stays inside the Latest shell.
export const dynamic = 'force-dynamic';

export default function V2QuestsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <QuestsPanel competitionsHref="/v2/competitions" />
    </main>
  );
}

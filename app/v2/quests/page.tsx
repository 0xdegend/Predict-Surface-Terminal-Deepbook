import type { Metadata } from 'next';
import { QuestsPanel } from '@/app/_components/rewards/quests-panel';

export const metadata: Metadata = {
  title: 'Quests',
  description:
    'Skew Quests: complete trading milestones to earn Skew Points. Progress tracks live from your own on-chain trading record; rewards open soon.',
};

// The v2 layout provides the chrome; the cross-link stays inside the Latest shell.
// The panel is a client component that reads the connected wallet's own record, so this
// route stays a thin shell and never renders a trader's numbers on the server.
export const dynamic = 'force-dynamic';

export default function V2QuestsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <QuestsPanel competitionsHref="/v2/competitions" />
    </main>
  );
}

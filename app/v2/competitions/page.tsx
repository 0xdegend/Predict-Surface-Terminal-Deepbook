import type { Metadata } from 'next';
import { DegenArena } from '@/app/_components/arena/degen-arena';

export const metadata: Metadata = {
  title: 'Competitions',
  description:
    'Degen Arena: Skew’s faction competition. Factions compete each season for a share of a DUSDC prize pool, split by faction rank and by each member’s performance.',
};

// Same self-contained Degen Arena as legacy /competitions — the v2 layout
// provides the chrome, and the cross-link stays inside the Latest shell.
export const dynamic = 'force-dynamic';

export default function V2CompetitionsPage() {
  return (
    <main className="flex flex-1 flex-col">
      <DegenArena questsHref="/v2/quests" />
    </main>
  );
}

import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { DegenArena } from '../_components/arena/degen-arena';

export const metadata: Metadata = {
  title: 'Competitions',
  description:
    'Degen Arena — Skew’s faction competition. Factions compete each season for a share of a DUSDC prize pool, split by faction rank and by each member’s performance.',
};

// A self-contained showcase of the Degen Arena faction competition (the live
// countdown is the only client-tick state) — renders the shared chrome + arena.
export const dynamic = 'force-dynamic';

export default function CompetitionsRoute() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="competitions" />
      <main className="flex flex-1 flex-col">
        <DegenArena />
      </main>
    </div>
  );
}

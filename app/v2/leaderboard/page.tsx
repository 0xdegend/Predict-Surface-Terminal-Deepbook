import type { Metadata } from 'next';
import { V2LeaderboardPanel } from '@/app/_components/v2/leaderboard-panel';

export const metadata: Metadata = {
  title: 'Leaderboard',
  description:
    'Season-2 standings on the new Predict release. Traders are ranked by Points and volume, fresh start for everyone.',
};

// Standings are client-rendered (wallet highlight + sample rows until the
// indexer exposes per-trader aggregation); this server route is just the shell.
export const dynamic = 'force-dynamic';

export default function V2LeaderboardPage() {
  return (
    <main className="flex flex-1 flex-col">
      <V2LeaderboardPanel />
    </main>
  );
}

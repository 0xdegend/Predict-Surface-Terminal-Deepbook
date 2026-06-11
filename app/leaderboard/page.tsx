import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { LeaderboardPanel } from '../_components/leaderboard/leaderboard-panel';

export const metadata: Metadata = {
  title: 'Leaderboard',
  description:
    'The Skew leaderboard — DeepBook Predict traders ranked live by points and volume from the public event stream.',
};

// The leaderboard is computed client-side from the public event stream (no
// wallet required), so this route just renders the shared chrome + client panel.
export const dynamic = 'force-dynamic';

export default function LeaderboardRoute() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="leaderboard" />
      <main className="flex flex-1 flex-col">
        <LeaderboardPanel />
      </main>
    </div>
  );
}

import type { Metadata } from 'next';
import { V2Season1Archive } from '@/app/_components/v2/season1-archive';

export const metadata: Metadata = {
  title: 'Season 1 archive',
  description:
    'The frozen Season 1 Predict leaderboard: final standings from the first release, kept as a snapshot after the deployment was retired.',
};

// A static snapshot: no live data, but the connected-wallet highlight is client-side,
// so keep the shell dynamic to match the rest of /v2.
export const dynamic = 'force-dynamic';

export default function V2Season1ArchivePage() {
  return (
    <main className="flex flex-1 flex-col">
      <V2Season1Archive />
    </main>
  );
}

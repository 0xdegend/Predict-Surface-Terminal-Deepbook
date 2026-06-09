import { TopChrome } from '../../_components/top-chrome';
import { TraderProfile } from '../../_components/trader/trader-profile';

// Public trader profile (standing + live open positions). Data is client-only
// (server API, no wallet), so this route just resolves the address param and
// renders the shared chrome + client profile.
export const dynamic = 'force-dynamic';

export default async function TraderRoute({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="leaderboard" />
      <main className="flex flex-1 flex-col">
        <TraderProfile address={decodeURIComponent(address)} />
      </main>
    </div>
  );
}

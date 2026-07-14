import type { Metadata } from 'next';
import { V2TraderProfile } from '@/app/_components/v2/trader/trader-profile';

export const metadata: Metadata = {
  title: 'Trader',
  description:
    'A trader’s Season-2 standing and live open positions on the new Predict release — copy any bet into your own trade ticket.',
};

// Public trader profile (standing + live open positions). Client-only data
// (indexer + on-chain account resolve, no wallet needed), so this route just
// resolves the address param and renders the client profile under the /v2 chrome.
export const dynamic = 'force-dynamic';

export default async function V2TraderRoute({
  params,
}: {
  params: Promise<{ address: string }>;
}) {
  const { address } = await params;
  return (
    <main className="flex flex-1 flex-col">
      <V2TraderProfile address={decodeURIComponent(address)} />
    </main>
  );
}

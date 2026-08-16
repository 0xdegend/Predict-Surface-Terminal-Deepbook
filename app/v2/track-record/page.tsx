import type { Metadata } from 'next';
import { KellyTrackRecordPanel } from '@/app/_components/v2/kelly-track-record-panel';

export const metadata: Metadata = {
  title: "Kelly's Track Record",
  description:
    'Every prediction Kelly makes on BTC is signed and written to Walrus the moment it lands, so it cannot be edited after the fact. See the win rate and verify every call.',
};

// The record is read client-side (fetched from /api/kelly/receipts + scored against live
// settlement); this server route is just the shell under the v2 chrome.
export const dynamic = 'force-dynamic';

export default function V2TrackRecordPage() {
  return (
    <main className="flex flex-1 flex-col">
      <KellyTrackRecordPanel />
    </main>
  );
}

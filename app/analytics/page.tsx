import type { Metadata } from 'next';
import { TopChrome } from '../_components/top-chrome';
import { AnalyticsPanel } from '../_components/analytics/analytics-panel';

export const metadata: Metadata = {
  title: 'Analytics',
  description:
    'Skew Analytics — live order flow and UP/DOWN sentiment across DeepBook Predict, computed from the public event stream.',
};

// Analytics is computed client-side from the public event stream (no wallet),
// so this route just renders the shared chrome + the client panel.
export const dynamic = 'force-dynamic';

export default function AnalyticsRoute() {
  return (
    <div className="flex min-h-screen flex-col">
      <TopChrome active="analytics" />
      <main className="flex flex-1 flex-col">
        <AnalyticsPanel />
      </main>
    </div>
  );
}

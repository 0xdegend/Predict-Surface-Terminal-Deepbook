import { KellyHubSkeleton } from '@/app/_components/v2/kelly/hub-skeleton';

// Route-level loading UI for the Kelly hub: the tab bar and the chat tab's two columns,
// so the page shows its shape while the live snapshot (markets + warm pricers) resolves.
export default function Loading() {
  return <KellyHubSkeleton />;
}

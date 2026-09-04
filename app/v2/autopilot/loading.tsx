import { AutopilotSkeleton } from '@/app/_components/v2/autopilot/skeleton';

// Route-level loading UI for /v2/autopilot. The page is force-dynamic and awaits the
// market snapshot plus warm pricers on the server, so a hard refresh would otherwise
// sit on the root trade-shaped skeleton (app/loading.tsx). This one is the Autopilot
// landing's own shape, so the layout arrives once and fills in.
export default function Loading() {
  return <AutopilotSkeleton />;
}

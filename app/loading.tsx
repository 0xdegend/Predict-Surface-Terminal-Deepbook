import { TradeSkeleton } from "./_components/trade-skeleton";

// Route-level loading UI for the trade page (app/page.tsx). A layout-matching
// skeleton instead of a blanking preloader, so the terminal shell shows its
// shape immediately while the live snapshot resolves. Sibling routes provide
// their own loading.tsx so they don't inherit this trade-shaped skeleton.
export default function Loading() {
  return <TradeSkeleton />;
}

import { TradeSkeleton } from "../_components/trade-skeleton";

// Route-level loading UI for the legacy trade terminal (app/legacy/page.tsx) —
// the layout-matching skeleton, same as the old root trade page used.
export default function Loading() {
  return <TradeSkeleton />;
}

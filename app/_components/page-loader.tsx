import { SkewLoaderVisual } from './skew-loader-visual';

/**
 * PageLoader — the centered brand preloader used as the route loading fallback
 * for pages that don't yet have a layout-matching skeleton. Kept as a shared
 * component so each route's loading.tsx is a one-liner; as we build per-page
 * skeletons (Portfolio, Leaderboard, …) we swap them in route by route.
 */
export function PageLoader() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-0">
      <SkewLoaderVisual />
    </div>
  );
}

import { SkewLoaderVisual } from './_components/skew-loader-visual';

/**
 * Route-change loading fallback (App Router). Next shows this automatically while
 * a navigated-to segment fetches its server data — the force-dynamic pages do
 * real work, so this branded loader fills the gap instead of a frozen screen.
 * Same animated mark as the initial Preloader for a seamless feel.
 */
export default function Loading() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-bg-0">
      <SkewLoaderVisual />
    </div>
  );
}

import { SimpleSkeleton } from '@/app/_components/v2/simple/simple-skeleton';

/**
 * Route-level loading UI for the simple round screen — the same layout-shaped skeleton
 * the screen falls back to on a cold load, so the switch paints instantly and the real
 * content fills the blocks that are already there.
 *
 * See `(terminal)/loading.tsx` for why these two exist.
 */
export default function Loading() {
  return <SimpleSkeleton />;
}

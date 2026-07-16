'use client';

/**
 * Replay affordance for the guided tour — a quiet "?" control in the top chrome.
 * Anyone (not just first-time visitors) can re-run the walkthrough from here.
 *
 * Only shown on the Trade screen ("/v2"): the tour's steps anchor to that
 * screen's sections, so it can't run anywhere else — offering it on
 * portfolio/leaderboard/vault/etc. would just start a broken, empty tour.
 */
import { usePathname } from 'next/navigation';
import { LuCircleHelp } from 'react-icons/lu';
import { useTourStore } from '@/lib/store/tour-store';

export function TourButton() {
  const pathname = usePathname();
  const start = useTourStore((s) => s.start);

  if (pathname !== '/v2') return null;

  return (
    <button
      type="button"
      onClick={start}
      aria-label="Take a tour"
      title="Take a tour"
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-white/[0.04] hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
    >
      <LuCircleHelp size={18} />
    </button>
  );
}

'use client';

/**
 * Replay affordance for the guided tour — a quiet "?" control in the top chrome.
 * Anyone (not just first-time visitors) can re-run the walkthrough from here.
 */
import { LuCircleHelp } from 'react-icons/lu';
import { useTourStore } from '@/lib/store/tour-store';

export function TourButton() {
  const start = useTourStore((s) => s.start);

  return (
    <button
      type="button"
      onClick={start}
      aria-label="Take a tour"
      title="Take a tour"
      className="hidden h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-white/[0.04] hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 sm:inline-flex"
    >
      <LuCircleHelp size={18} />
    </button>
  );
}

'use client';

/**
 * First-visit trigger for the guided tour. Renders nothing — it just auto-opens
 * the tour once per browser (localStorage flag) when a new user lands on the
 * home route. Gated to "/" so the tour, which targets the trade screen's
 * sections, never fires on portfolio/leaderboard/etc. Desktop-only: the
 * spotlight's scroll-to-each-section flow is awkward on phones/tablets, so we
 * skip it below the `lg` layout breakpoint (the replay "?" is hidden there too).
 * A short delay lets the shell hydrate and the surface container settle before
 * the spotlight measures.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useTourStore } from '@/lib/store/tour-store';
import { TOUR_SEEN_KEY } from './tour-overlay';

/** Matches Tailwind's `lg` — the width at which the desktop two-column layout appears. */
const DESKTOP_MQ = '(min-width: 1024px)';

export function TourLauncher() {
  const pathname = usePathname();
  const start = useTourStore((s) => s.start);

  useEffect(() => {
    if (pathname !== '/') return;
    // Desktop only. Don't mark "seen" here — a phone visitor should still get the
    // tour the first time they open the app on a desktop.
    if (!window.matchMedia(DESKTOP_MQ).matches) return;
    let seen = true;
    try {
      seen = window.localStorage.getItem(TOUR_SEEN_KEY) === 'done';
    } catch {
      seen = false; // storage blocked — treat as a first visit
    }
    if (seen) return;
    const t = window.setTimeout(start, 900);
    return () => window.clearTimeout(t);
  }, [pathname, start]);

  return null;
}

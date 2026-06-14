'use client';

/**
 * First-visit trigger for the guided tour. Renders nothing — it just auto-opens
 * the tour once per browser (localStorage flag) when a new user lands on the
 * home route. Gated to "/" so the tour, which targets the trade screen's
 * sections, never fires on portfolio/leaderboard/etc. Works on mobile too now:
 * the redesigned tour is a fixed bottom card (static on phones — no moving
 * spotlight/scroll), so the flow that made it awkward on mobile is gone. A short
 * delay lets the shell hydrate and the surface container settle.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useTourStore } from '@/lib/store/tour-store';
import { TOUR_SEEN_KEY } from './tour-overlay';

export function TourLauncher() {
  const pathname = usePathname();
  const start = useTourStore((s) => s.start);

  useEffect(() => {
    if (pathname !== '/') return;
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

'use client';

/**
 * First-visit trigger for the guided tour. Renders nothing — it just auto-opens
 * the tour once per browser (localStorage flag) when a new user lands on the
 * Trade screen. Gated to "/v2" (the live Trade route) so the tour, which targets
 * that screen's sections, never fires on portfolio/leaderboard/etc. Works on mobile too now:
 * the redesigned tour is a fixed bottom card (static on phones — no moving
 * spotlight/scroll), so the flow that made it awkward on mobile is gone. A short
 * delay lets the shell hydrate and the surface container settle.
 */
import { useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { useTourStore } from '@/lib/store/tour-store';
import { useTradeViewStore } from '@/lib/store/trade-view-store';
import { V2_EXPERIENCE_PROMPT_ENABLED } from '@/config/predict';
import { TOUR_SEEN_KEY } from './tour-overlay';

export function TourLauncher() {
  const pathname = usePathname();
  const start = useTourStore((s) => s.start);
  const stop = useTourStore((s) => s.stop);
  const active = useTourStore((s) => s.active);
  // The experience prompt fires on the same route and the same visit as this tour.
  // Hold until it's answered, or the tour starts underneath an open dialog — and for
  // anyone who answers "I'm new to this", it would start on a screen they're about to
  // leave. Answering re-runs this effect, so an advanced pick still gets the tour.
  const choicePending = useTradeViewStore((s) => V2_EXPERIENCE_PROMPT_ENABLED && !s.chosen);

  useEffect(() => {
    if (pathname !== '/v2') return;
    if (choicePending) return;
    let seen = true;
    try {
      seen = window.localStorage.getItem(TOUR_SEEN_KEY) === 'done';
    } catch {
      seen = false; // storage blocked — treat as a first visit
    }
    if (seen) return;
    const t = window.setTimeout(start, 900);
    return () => window.clearTimeout(t);
  }, [pathname, choicePending, start]);

  // If the tour is running and the user leaves the Trade screen, end it — its
  // steps anchor to that screen, so it can't continue on another page.
  useEffect(() => {
    if (active && pathname !== '/v2') stop();
  }, [active, pathname, stop]);

  return null;
}

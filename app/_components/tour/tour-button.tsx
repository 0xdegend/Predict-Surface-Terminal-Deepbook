'use client';

/**
 * Help affordance in the top chrome — a quiet "?" that opens a small menu of guided
 * tours: "Take a tour" (orientation, what's on screen) and "How to place a trade" (the
 * step-by-step trade walkthrough for new traders). Anyone can replay either from here.
 *
 * Only shown on the Trade screen ("/v2"): the tours anchor to that screen's sections, so
 * they can't run anywhere else — offering them on portfolio/leaderboard/etc. would just
 * start a broken, empty tour.
 */
import { useState } from 'react';
import { usePathname } from 'next/navigation';
import { LuCircleHelp, LuCompass, LuGraduationCap } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useTourStore } from '@/lib/store/tour-store';
import { TOURS, type TourId } from '@/lib/tour/steps';

const ICONS: Record<TourId, IconType> = {
  orientation: LuCompass,
  trade: LuGraduationCap,
};
const ORDER: TourId[] = ['orientation', 'trade'];

export function TourButton() {
  const pathname = usePathname();
  const start = useTourStore((s) => s.start);
  const [open, setOpen] = useState(false);

  if (pathname !== '/v2') return null;

  const launch = (id: TourId) => {
    setOpen(false);
    start(id);
  };

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label="Help and tours"
        aria-haspopup="menu"
        aria-expanded={open}
        title="Help and tours"
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-text-3 transition-colors hover:bg-white/[0.04] hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
      >
        <LuCircleHelp size={18} />
      </button>

      {open && (
        <>
          {/* Outside-click / Esc catcher. */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            aria-label="Guided tours"
            className="glass popover-in absolute right-0 top-full z-50 mt-1.5 w-64 rounded-xl p-1.5 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.8)]"
          >
            <span className="block px-2.5 py-1 text-[9px] font-medium uppercase tracking-[0.18em] text-text-3">
              New here? Take a tour
            </span>
            {ORDER.map((id) => {
              const t = TOURS[id];
              const Icon = ICONS[id];
              return (
                <button
                  key={id}
                  type="button"
                  role="menuitem"
                  onClick={() => launch(id)}
                  className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-white/[0.05] focus-visible:outline-none focus-visible:bg-white/[0.05]"
                >
                  <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-line bg-white/[0.02] text-accent">
                    <Icon size={13} />
                  </span>
                  <span className="flex min-w-0 flex-col">
                    <span className="text-[12.5px] font-medium text-text-1">{t.label}</span>
                    <span className="text-[11px] leading-snug text-text-3">{t.blurb}</span>
                  </span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import {
  LuActivity,
  LuWallet,
  LuVault,
  LuTrophy,
  LuShieldAlert,
  LuTarget,
  LuSwords,
  LuLayoutGrid,
  LuBookOpen,
  LuChartNoAxesCombined,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useSurfaceStore } from '@/lib/store/surface-store';

/**
 * Mobile bottom tab bar (§10.5, Phase 6 mobile). On small screens the top-chrome
 * nav collapses into a *floating* frosted-glass dock: a pill that hovers above
 * the page edge with a gliding accent "lens" sliding under the active tab.
 *
 * The terminal now has more destinations than fit a dock, so it mirrors the
 * desktop information architecture: four primary tabs + a "More" overflow that
 * opens a bottom sheet for the secondary screens (Vault Risk, and the Quests /
 * Competitions rewards roadmap). The "More" tab lights up while you're on any of
 * those routes. iOS safe-area aware; hidden at lg+ where the inline header nav
 * (with its Rewards / Vault dropdowns) takes over.
 */
const PRIMARY: { href: string; label: string; icon: IconType; match: (p: string) => boolean }[] = [
  { href: '/', label: 'Trade', icon: LuActivity, match: (p) => p === '/' },
  { href: '/portfolio', label: 'Portfolio', icon: LuWallet, match: (p) => p.startsWith('/portfolio') },
  { href: '/vault', label: 'Vault', icon: LuVault, match: (p) => p.startsWith('/vault') },
  {
    // "Ranks" (not "Leaders") — short enough for the dock and, with the trophy,
    // unambiguously the standings. The desktop header still reads "Leaderboard".
    href: '/leaderboard',
    label: 'Ranks',
    icon: LuTrophy,
    match: (p) => p.startsWith('/leaderboard') || p.startsWith('/trader'),
  },
];

// Secondary destinations behind the "More" sheet — the same grouping the desktop
// header uses (Risk under the Vault group; Quests/Competitions under Rewards).
const MORE: { href: string; label: string; desc: string; icon: IconType; soon?: boolean }[] = [
  { href: '/analytics', label: 'Analytics', desc: 'Live flow & sentiment', icon: LuChartNoAxesCombined },
  { href: '/risk', label: 'Vault Risk', desc: 'Pool health & safety check', icon: LuShieldAlert },
  { href: '/quests', label: 'Quests', desc: 'Trade milestones · earn DUSDC', icon: LuTarget, soon: true },
  { href: '/competitions', label: 'Competitions', desc: 'Seasonal races · prize pools', icon: LuSwords, soon: true },
  { href: '/docs', label: 'Docs', desc: 'How to trade · read the surface', icon: LuBookOpen },
];

export function BottomNav() {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  // The mobile trade sheet is a focused modal that slides up over this dock — so
  // tuck the dock away while it's open (otherwise it floats on top of the sheet's
  // bottom content, which is exactly where the range-pick curve lives).
  const ticketSheetOpen = useSurfaceStore((s) => s.ticketSheetOpen);

  const primaryIndex = PRIMARY.findIndex((t) => t.match(pathname));
  const moreActive = MORE.some((m) => pathname.startsWith(m.href));
  // The lens sits under a primary tab, or under "More" (index 4) when on one of
  // its routes. -1 (no lens) on an unmatched route.
  const activeIndex = primaryIndex >= 0 ? primaryIndex : moreActive ? 4 : -1;

  // Esc closes the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    // Outer layer positions + centers; pointer-events pass through the gaps so
    // only the dock (and, when open, the sheet/backdrop) are interactive.
    <nav
      aria-label="Primary"
      aria-hidden={ticketSheetOpen}
      className={`pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.6rem)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:hidden ${
        ticketSheetOpen ? 'pointer-events-none translate-y-[130%]' : 'translate-y-0'
      }`}
    >
      {/* Backdrop — dims the page behind the sheet; tap to dismiss. Sits behind
          the sheet + dock (negative z within this stacking context) but above
          page content. */}
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="pointer-events-auto fixed inset-0 -z-10 bg-[rgba(8,9,11,0.66)]"
          style={{ animation: 'fadeIn 0.2s ease' }}
        />
      )}

      {/* The "More" sheet — sits just above the dock, same width + glass language. */}
      {open && (
        <div
          role="menu"
          className="glass-dock sheet-in pointer-events-auto mb-2.5 w-full max-w-md overflow-hidden rounded-[22px] p-2"
        >
          <div className="flex flex-col gap-1.5">
            {MORE.map((item) => {
              const active = pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={`ctrl-soft flex items-center gap-3 rounded-2xl px-3.5 py-3 transition-colors ${
                    active ? 'text-text-1' : 'text-text-2'
                  }`}
                >
                  <Icon size={18} className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`} />
                  <span className="flex flex-1 flex-col gap-1">
                    <span className="text-[13px] font-medium leading-none">{item.label}</span>
                    <span className="text-[11px] leading-none text-text-3">{item.desc}</span>
                  </span>
                  {item.soon && (
                    <span
                      className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest"
                      style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}
                    >
                      Soon
                    </span>
                  )}
                </Link>
              );
            })}
          </div>
        </div>
      )}

      {/* The dock — four primary tabs + the More overflow. */}
      <div className="glass-dock pointer-events-auto relative grid w-full max-w-md grid-cols-5 rounded-[20px] p-1.5">
        {/* gliding accent lens behind the active tab */}
        {activeIndex >= 0 && (
          <span
            aria-hidden
            className="dock-thumb pointer-events-none absolute inset-y-1.5 left-1.5 rounded-2xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
            style={{
              width: 'calc((100% - 0.75rem) / 5)',
              transform: `translateX(calc(${activeIndex} * 100%))`,
            }}
          />
        )}
        {PRIMARY.map((tab) => {
          const active = tab.match(pathname);
          const Icon = tab.icon;
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={`relative z-10 flex flex-col items-center justify-center gap-1 rounded-2xl py-2 text-[10px] font-medium tracking-tight transition-colors ${
                active ? 'text-text-1' : 'text-text-3 hover:text-text-2'
              }`}
            >
              <Icon
                size={18}
                className={`transition-transform duration-200 ${active ? 'scale-110 text-accent' : ''}`}
              />
              <span>{tab.label}</span>
            </Link>
          );
        })}

        {/* More — opens the secondary-destinations sheet. Active while on one of
            its routes, or while the sheet is open. */}
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-haspopup="menu"
          aria-current={moreActive ? 'page' : undefined}
          className={`relative z-10 flex flex-col items-center justify-center gap-1 rounded-2xl py-2 text-[10px] font-medium tracking-tight transition-colors ${
            moreActive || open ? 'text-text-1' : 'text-text-3 hover:text-text-2'
          }`}
        >
          <LuLayoutGrid
            size={18}
            className={`transition-transform duration-200 ${moreActive || open ? 'scale-110 text-accent' : ''}`}
          />
          <span>More</span>
        </button>
      </div>
    </nav>
  );
}

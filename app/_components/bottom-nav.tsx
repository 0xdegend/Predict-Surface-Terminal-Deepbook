'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LuActivity, LuWallet, LuVault, LuTrophy, LuShieldAlert } from 'react-icons/lu';
import type { IconType } from 'react-icons';

/**
 * Mobile bottom tab bar (§10.5, Phase 6 mobile). On small screens the five
 * top-chrome nav links collapse into a *floating* frosted-glass dock: a pill
 * that hovers above the page edge with a gliding accent "lens" sliding under the
 * active tab. iOS safe-area aware. Hidden at lg+ where the inline header nav
 * takes over. Active state is route-derived (usePathname), so no prop threading.
 */
const TABS: { href: string; label: string; icon: IconType; match: (p: string) => boolean }[] = [
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
  { href: '/risk', label: 'Risk', icon: LuShieldAlert, match: (p) => p.startsWith('/risk') },
];

export function BottomNav() {
  const pathname = usePathname() ?? '/';
  const activeIndex = TABS.findIndex((t) => t.match(pathname));

  return (
    // Outer layer positions + centers; pointer-events pass through the gaps so
    // only the dock itself is interactive.
    <nav
      aria-label="Primary"
      className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.6rem)] lg:hidden"
    >
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
        {TABS.map((tab) => {
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
      </div>
    </nav>
  );
}

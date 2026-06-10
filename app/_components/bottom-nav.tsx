'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LuActivity, LuWallet, LuVault, LuTrophy, LuShieldAlert } from 'react-icons/lu';
import type { IconType } from 'react-icons';

/**
 * Mobile bottom tab bar (§10.5, Phase 6 mobile). On small screens the five
 * top-chrome nav links collapse into a fixed, app-style dock: equal-width
 * icon+label tabs, glass surface, iOS safe-area aware. Hidden at lg+ where the
 * inline header nav takes over. Active state is derived from the route so it
 * needs no prop threading across pages. Client-only (usePathname).
 */
const TABS: { href: string; label: string; icon: IconType; match: (p: string) => boolean }[] = [
  { href: '/', label: 'Trade', icon: LuActivity, match: (p) => p === '/' },
  { href: '/portfolio', label: 'Portfolio', icon: LuWallet, match: (p) => p.startsWith('/portfolio') },
  { href: '/vault', label: 'Vault', icon: LuVault, match: (p) => p.startsWith('/vault') },
  {
    href: '/leaderboard',
    label: 'Leaders',
    icon: LuTrophy,
    match: (p) => p.startsWith('/leaderboard') || p.startsWith('/trader'),
  },
  { href: '/risk', label: 'Risk', icon: LuShieldAlert, match: (p) => p.startsWith('/risk') },
];

export function BottomNav() {
  const pathname = usePathname() ?? '/';

  return (
    <nav
      aria-label="Primary"
      className="glass fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t pb-[env(safe-area-inset-bottom)] lg:hidden"
    >
      {TABS.map((tab) => {
        const active = tab.match(pathname);
        const Icon = tab.icon;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={`group relative flex flex-col items-center justify-center gap-1 py-2.5 text-[10px] font-medium tracking-tight transition-colors ${
              active ? 'text-text-1' : 'text-text-3 hover:text-text-2'
            }`}
          >
            {/* active indicator — a short accent bar pinned to the top edge */}
            <span
              className={`absolute inset-x-0 top-0 mx-auto h-0.5 w-8 rounded-full bg-accent transition-opacity ${
                active ? 'opacity-100' : 'opacity-0'
              }`}
            />
            <Icon
              size={19}
              className={`transition-transform ${active ? 'scale-105 text-accent' : ''}`}
            />
            <span>{tab.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

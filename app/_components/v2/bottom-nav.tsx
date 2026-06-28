'use client';

/**
 * V2BottomNav — mobile tab dock for the Latest deployment (parallel of the legacy
 * BottomNav). A floating frosted-glass pill with the primary /v2/* destinations;
 * hidden at lg+ where the header nav takes over. iOS safe-area aware.
 *
 * Sibling of the chrome (not nested) so its fixed positioning anchors to the
 * viewport, not a backdrop-filter container.
 */
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { LuActivity, LuWallet, LuTrophy, LuVault } from 'react-icons/lu';
import type { IconType } from 'react-icons';

const TABS: { href: string; label: string; icon: IconType; match: (p: string) => boolean }[] = [
  { href: '/v2', label: 'Trade', icon: LuActivity, match: (p) => p === '/v2' },
  { href: '/v2/portfolio', label: 'Portfolio', icon: LuWallet, match: (p) => p.startsWith('/v2/portfolio') },
  { href: '/v2/leaderboard', label: 'Ranks', icon: LuTrophy, match: (p) => p.startsWith('/v2/leaderboard') },
  { href: '/v2/vault', label: 'Vault', icon: LuVault, match: (p) => p.startsWith('/v2/vault') },
];

export function V2BottomNav() {
  const pathname = usePathname() ?? '';
  return (
    <nav
      className="glass fixed inset-x-0 bottom-0 z-40 flex items-stretch justify-around gap-1 border-t px-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] pt-2 lg:hidden"
      aria-label="Primary"
    >
      {TABS.map((t) => {
        const active = t.match(pathname);
        const Icon = t.icon;
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`flex flex-1 flex-col items-center gap-0.5 rounded-lg py-1 text-[10px] font-medium transition-colors ${
              active ? 'text-text-1' : 'text-text-3 hover:text-text-2'
            }`}
          >
            <Icon size={18} className={active ? 'text-accent' : ''} />
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}

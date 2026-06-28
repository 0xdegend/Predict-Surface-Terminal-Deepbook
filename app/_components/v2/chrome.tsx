'use client';

/**
 * V2Chrome — the persistent terminal chrome for the NEW (Latest) deployment.
 *
 * A parallel of TopChrome (frozen for legacy) with nav pointing at /v2/* routes,
 * the live BTC chip, the Legacy↔Latest toggle, and the wallet. Same glass three-
 * zone layout. Desktop nav keeps primary destinations inline and folds the rest
 * into a "More" dropdown so it never overflows at lg (mobile uses V2BottomNav).
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import { LuChevronDown } from 'react-icons/lu';
import { WalletBar } from '../wallet-bar';
import { DeploymentToggle } from '../deployment-toggle';
import { V2SpotTape } from './spot-tape';

type NavItem = { href: string; label: string; exact?: boolean };

const PRIMARY: NavItem[] = [
  { href: '/v2', label: 'Trade', exact: true },
  { href: '/v2/portfolio', label: 'Portfolio' },
  { href: '/v2/leaderboard', label: 'Leaderboard' },
];
const MORE: NavItem[] = [
  { href: '/v2/analytics', label: 'Analytics' },
  { href: '/v2/vault', label: 'Vault' },
  { href: '/docs', label: 'Docs' },
];

const matches = (p: string, n: NavItem) => (n.exact ? p === n.href : p.startsWith(n.href));

export function V2Chrome() {
  const pathname = usePathname() ?? '';

  return (
    <header className="glass sticky top-0 z-40 grid h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 sm:gap-4 sm:px-5 lg:grid-cols-[1fr_auto_1fr]">
      {/* brand + nav */}
      <div className="flex shrink-0 items-center gap-3 sm:gap-5">
        <Link href="/v2" className="group flex items-center gap-2" aria-label="Skew — Latest home">
          <Image
            src="/skew-mark.png"
            alt=""
            width={22}
            height={22}
            priority
            className="h-5.5 w-5.5 transition-transform group-hover:scale-105"
          />
          <span className="hidden text-[15px] font-semibold tracking-tight text-text-1 sm:inline">Skew</span>
        </Link>
        <nav className="hidden items-center gap-1 lg:flex">
          {PRIMARY.map((n) => (
            <NavLink key={n.href} href={n.href} label={n.label} active={matches(pathname, n)} />
          ))}
          <NavMore items={MORE} active={MORE.some((n) => matches(pathname, n))} pathname={pathname} />
        </nav>
      </div>

      {/* live chip */}
      <div className="flex min-w-0 justify-center">
        <div className="hidden sm:block">
          <V2SpotTape />
        </div>
      </div>

      {/* toggle + wallet */}
      <div className="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
        <DeploymentToggle />
        <WalletBar />
      </div>
    </header>
  );
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-md px-2.5 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
        active ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
      }`}
    >
      {label}
    </Link>
  );
}

function NavMore({ items, active, pathname }: { items: NavItem[]; active: boolean; pathname: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
          active ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
        }`}
        aria-expanded={open}
      >
        More
        <LuChevronDown size={13} className={`text-text-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="glass-menu popover-in absolute left-0 top-[calc(100%+8px)] z-50 w-44 overflow-hidden rounded-xl p-1.5">
          {items.map((n) => (
            <Link
              key={n.href}
              href={n.href}
              onClick={() => setOpen(false)}
              className={`block rounded-lg px-3 py-2 text-[12px] transition-colors ${
                matches(pathname, n) ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:bg-white/4 hover:text-text-1'
              }`}
            >
              {n.label}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

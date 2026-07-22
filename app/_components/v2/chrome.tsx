'use client';

/**
 * V2Chrome — the persistent terminal chrome for the NEW (Latest) deployment.
 *
 * A parallel of TopChrome (frozen for legacy) with nav pointing at /v2/* routes,
 * the live BTC chip, the Legacy↔Latest toggle, and the wallet. Same glass three-
 * zone layout AND the same nav arrangement as legacy: Trade · Portfolio ·
 * Analytics · Leaderboard inline, then a rich "Vault" dropdown and a rich "More"
 * dropdown (Quests / Competitions / Docs) whose triggers adopt the active
 * sub-page's label. Mobile uses V2BottomNav.
 */
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { usePathname } from 'next/navigation';
import {
  LuChevronDown,
  LuVault,
  LuShieldAlert,
  LuTarget,
  LuSwords,
  LuBookOpen,
  LuKeyRound,
  LuSparkles,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { WalletBar } from '../wallet-bar';
import { DeploymentToggle } from '../deployment-toggle';
import { TourButton } from '../tour/tour-button';
import { V2SpotTape } from './spot-tape';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { isAdminAddress } from '@/config/predict';

type NavItem = { href: string; label: string; exact?: boolean };
type MenuItem = { href: string; label: string; desc: string; icon: IconType; soon?: boolean };

const PRIMARY: NavItem[] = [
  { href: '/v2', label: 'Trade', exact: true },
  { href: '/v2/portfolio', label: 'Portfolio' },
  { href: '/v2/analytics', label: 'Analytics' },
  { href: '/v2/leaderboard', label: 'Leaderboard' },
];

/** Vault group — mirrors legacy NavVault (Vault + Vault Risk). */
const VAULT_ITEMS: MenuItem[] = [
  { href: '/v2/vault', label: 'Vault', desc: 'Add liquidity · earn the trading edge', icon: LuVault },
  { href: '/v2/risk', label: 'Vault Risk', desc: 'Pool health & safety check', icon: LuShieldAlert },
];

/** Secondary destinations — same set as the legacy "More" menu. Quests /
 *  Competitions render the shared showcase panels under the v2 shell; Docs
 *  renders the shared manual under the v2 shell too (/v2/docs) so it keeps the
 *  Latest chrome and its in-page links stay on /v2. */
const MORE_ITEMS: MenuItem[] = [
  { href: '/v2/copilot', label: 'Co-pilot', desc: 'Talk to the surface · set up a bet', icon: LuSparkles },
  { href: '/v2/quests', label: 'Quests', desc: 'Trade milestones · earn DUSDC', icon: LuTarget, soon: true },
  { href: '/v2/competitions', label: 'Degen Arena', desc: 'Factions clash · prize pools', icon: LuSwords, soon: true },
  { href: '/v2/docs', label: 'Docs', desc: 'How to trade · read the surface', icon: LuBookOpen },
];

const matches = (p: string, n: NavItem) => (n.exact ? p === n.href : p.startsWith(n.href));

export function V2Chrome() {
  const pathname = usePathname() ?? '';

  // Builder fees shows only for a team wallet (config allowlist). Gating on code
  // ownership instead would hide the link from the very wallet that still needs to
  // register the first code — and would surface it to any stranger who registered
  // a code of their own. The page and the chain gate it again regardless.
  const account = useCurrentAccount();
  const moreItems: MenuItem[] = isAdminAddress(account?.address)
    ? [
        ...MORE_ITEMS,
        {
          href: '/v2/admin',
          label: 'Builder fees',
          desc: 'Claim protocol builder fees',
          icon: LuKeyRound,
        },
      ]
    : MORE_ITEMS;

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
          <NavMenu fallbackLabel="Vault" items={VAULT_ITEMS} pathname={pathname} />
          <NavMenu fallbackLabel="More" items={moreItems} pathname={pathname} />
        </nav>
      </div>

      {/* live chip */}
      <div data-tour="chip" className="flex min-w-0 justify-center">
        <div className="hidden sm:block">
          <V2SpotTape />
        </div>
      </div>

      {/* toggle + wallet */}
      <div className="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
        <TourButton />
        <DeploymentToggle />
        <WalletBar />
      </div>
    </header>
  );
}

/**
 * Shared nav-item styling so the inline links and the Vault/More dropdown triggers
 * read identically. Active = a framed "selected" state (accent tint + hairline
 * accent border), the design system's canonical selection treatment; rest = quiet
 * muted text that lifts to primary with a soft wash on hover. The border is
 * transparent at rest, so selecting an item never shifts the row by a pixel.
 */
function navItemClass(active: boolean): string {
  return `rounded-md border px-3 py-1.5 text-[13px] font-medium tracking-tight transition-colors duration-200 ${
    active
      ? 'border-(--accent-line) bg-(--accent-soft) text-text-1'
      : 'border-transparent text-text-2 hover:bg-white/[0.035] hover:text-text-1'
  }`;
}

function NavLink({ href, label, active }: { href: string; label: string; active: boolean }) {
  return (
    <Link href={href} aria-current={active ? 'page' : undefined} className={navItemClass(active)}>
      {label}
    </Link>
  );
}

/**
 * Route-aware dropdown in the legacy nav language: the trigger adopts the
 * active sub-page's label, and the menu is rich rows (icon · label · plain-copy
 * description, optional "Soon" chip) on the frosted glass-menu surface.
 */
function NavMenu({
  fallbackLabel,
  items,
  pathname,
}: {
  fallbackLabel: string;
  items: MenuItem[];
  pathname: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeItem = items.find((i) => pathname.startsWith(i.href));

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
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className={`flex items-center gap-1 ${navItemClass(!!activeItem)}`}
      >
        {activeItem ? activeItem.label : fallbackLabel}
        <LuChevronDown
          size={13}
          className={`transition-transform duration-200 ${open ? 'rotate-180 text-text-2' : 'text-text-3'}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="glass-menu popover-in absolute left-0 top-[calc(100%+10px)] z-50 w-64 overflow-hidden rounded-2xl p-2"
        >
          <div className="flex flex-col gap-1.5">
            {items.map((item) => {
              const active = pathname.startsWith(item.href);
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  role="menuitem"
                  onClick={() => setOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={`ctrl-soft flex items-center gap-3 rounded-xl px-3.5 py-3 transition-colors ${
                    active ? 'text-text-1' : 'text-text-2 hover:text-text-1'
                  }`}
                >
                  <Icon size={16} className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`} />
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
    </div>
  );
}

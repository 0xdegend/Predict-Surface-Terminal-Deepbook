'use client';

/**
 * V2Chrome — the persistent terminal chrome for the NEW (Latest) deployment.
 *
 * A parallel of TopChrome (frozen for legacy) with nav pointing at /v2/* routes,
 * the live BTC chip, the Simple↔Advanced toggle, and the wallet. Same glass three-
 * zone layout AND the same nav arrangement as legacy: Trade · Portfolio ·
 * Analytics · Leaderboard inline, then a rich "Vault" dropdown and a rich "More"
 * dropdown (Quests / Competitions / Docs) whose triggers adopt the active
 * sub-page's label. Mobile uses V2BottomNav.
 *
 * The header holds ONE switch, and only on the trade screen: Simple ⇄ Advanced. The
 * Legacy ⇄ Latest deployment toggle used to live here on every other page — a control
 * about which PROTOCOL you're on, sitting beside pages that have nothing to do with the
 * choice. The Legacy deployment is no longer linked from the nav at all; /legacy
 * still resolves for anyone holding the URL.
 *
 * Desktop only. Phones reach the same switch from the dock's More sheet, which is the
 * mobile counterpart of this header — see [[app/_components/v2/bottom-nav]].
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
  LuChartCandlestick,
  LuArrowUpRight,
  LuBadgeCheck,
  LuGauge,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { WalletBar } from '../wallet-bar';
import { TradeModeToggle } from './trade-mode-toggle';
import { useTradeViewStore, tradeHref, isTradeRoute } from '@/lib/store/trade-view-store';
import { usePythTapeSpotFeed } from '@/lib/hooks/use-v2-pyth-history';
import { useMounted } from '@/lib/hooks/use-mounted';
import { TourButton } from '../tour/tour-button';
import { SocialIconLinks, SOCIAL_ICON } from '../social-links';
import { SOCIALS } from '@/config/socials';
import { V2SpotTape } from './spot-tape';
import { useCurrentAccount } from '@mysten/dapp-kit-react';
import { isAdminAddress, V2_SIMPLE_ENABLED } from '@/config/predict';

type NavItem = { href: string; label: string; exact?: boolean };
type MenuItem = {
  href: string;
  label: string;
  desc: string;
  icon: IconType;
  soon?: boolean;
  /** Renders full-width at the bottom of a grid menu instead of as a tile (e.g. Docs = "help"). */
  footer?: boolean;
  /** An off-site link (e.g. a social account) — opens in a new tab, never route-active. */
  external?: boolean;
};

/** "Follow @handle" rows for the More menu, one per social, from the shared list. */
const SOCIAL_ITEMS: MenuItem[] = SOCIALS.map((s) => ({
  href: s.url,
  label: `Follow on ${s.label}`,
  desc: s.handle,
  icon: SOCIAL_ICON[s.id],
  footer: true,
  external: true,
}));

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

/** Secondary destinations — same set as the legacy "More" menu, rendered as a
 *  two-column launcher grid so the list stays short as it grows. Live tools sit
 *  on top, the coming-soon gamification below, and Docs (help) spans the bottom
 *  as a full-width footer. Quests / Competitions render the shared showcase
 *  panels under the v2 shell; Docs renders the shared manual under the v2 shell
 *  too (/v2/docs) so it keeps the Latest chrome and its in-page links stay on /v2. */
// Kelly's Track Record ships with the receipts feature — nav entry only when it's on.
const KELLY_RECEIPTS = process.env.NEXT_PUBLIC_KELLY_RECEIPTS === '1';
// Autopilot is dark until released — nav entry only when it's on.
const AUTOPILOT = process.env.NEXT_PUBLIC_AUTOPILOT === '1';

const MORE_ITEMS: MenuItem[] = [
  { href: '/v2/options', label: 'BTC Options', desc: 'Live surface · probability ladder · expected move', icon: LuChartCandlestick },
  { href: '/v2/copilot', label: 'Kelly', desc: 'Talk to the surface · set up a bet', icon: LuSparkles },
  ...(AUTOPILOT
    ? [{ href: '/v2/autopilot', label: 'Autopilot', desc: 'Kelly trades your rules, hands-free', icon: LuGauge } as MenuItem]
    : []),
  ...(KELLY_RECEIPTS
    ? [{ href: '/v2/track-record', label: "Kelly's Record", desc: 'Every call, signed on Walrus', icon: LuBadgeCheck } as MenuItem]
    : []),
  { href: '/v2/quests', label: 'Quests', desc: 'Trade milestones · earn DUSDC', icon: LuTarget, soon: true },
  { href: '/v2/competitions', label: 'Degen Arena', desc: 'Factions clash · prize pools', icon: LuSwords, soon: true },
  { href: '/v2/docs', label: 'Docs', desc: 'How to trade · read the surface', icon: LuBookOpen, footer: true },
];

const matches = (p: string, n: NavItem) => (n.exact ? p === n.href : p.startsWith(n.href));

export function V2Chrome() {
  const pathname = usePathname() ?? '';

  // The chrome outlives every /v2 route and keeps polling while the tab is hidden, so
  // it's the one place that can keep the price charts' rolling history buffer unbroken
  // across a route change or an alt-tab. Rides the spot tape's existing read — no extra
  // network. See the hook for why backfilling afterwards can't do the same job.
  usePythTapeSpotFeed();

  // Simple/Advanced: remember the trader's last-used trade view so the Trade tab
  // and logo reopen it (default simple). Mounted-guarded so a persisted 'advanced'
  // can't cause an SSR href mismatch. Inert unless V2_SIMPLE_ENABLED.
  const tradeView = useTradeViewStore((s) => s.view);
  const mounted = useMounted();
  const tradeTarget = V2_SIMPLE_ENABLED && mounted ? tradeHref(tradeView, true) : '/v2';

  // Builder fees shows only for a team wallet (config allowlist). Gating on code
  // ownership instead would hide the link from the very wallet that still needs to
  // register the first code — and would surface it to any stranger who registered
  // a code of their own. The page and the chain gate it again regardless.
  const account = useCurrentAccount();
  // Socials sit at the very bottom of the menu (below Docs / any Admin row).
  const moreItems: MenuItem[] = isAdminAddress(account?.address)
    ? [
        ...MORE_ITEMS,
        {
          href: '/v2/admin',
          label: 'Admin',
          desc: 'Claim protocol builder fees',
          icon: LuKeyRound,
          // Full-width row like Docs (not a 5th tile) so the launcher grid never
          // leaves an odd hole. Matches the "any Admin row" note above.
          footer: true,
        },
        ...SOCIAL_ITEMS,
      ]
    : [...MORE_ITEMS, ...SOCIAL_ITEMS];

  return (
    <header className="glass sticky top-0 z-40 grid h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 sm:gap-4 sm:px-5 lg:grid-cols-[1fr_auto_1fr]">
      {/* brand + nav */}
      <div className="flex shrink-0 items-center gap-3 sm:gap-5">
        <Link href={tradeTarget} className="group flex items-center gap-2" aria-label="Skew — Latest home">
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
          {PRIMARY.map((n) => {
            // "Trade" opens the remembered view (simple/advanced) and stays active
            // across both trade routes; every other tab is unchanged.
            const isTrade = n.label === 'Trade';
            const href = isTrade && V2_SIMPLE_ENABLED ? tradeTarget : n.href;
            const active = isTrade ? isTradeRoute(pathname) : matches(pathname, n);
            return <NavLink key={n.label} href={href} label={n.label} active={active} />;
          })}
          <NavMenu fallbackLabel="Vault" items={VAULT_ITEMS} pathname={pathname} />
          <NavMenu fallbackLabel="More" items={moreItems} pathname={pathname} grid />
        </nav>
      </div>

      {/* live chip — the always-on BTC price, shown on every breakpoint (it fills
          the otherwise-empty middle of the mobile bar, and Pyth spot stays live
          even while markets are paused). */}
      <div data-tour="chip" className="flex min-w-0 justify-center">
        <V2SpotTape />
      </div>

      {/* socials + toggle + wallet. Socials are desktop-only (hidden lg:flex) so
          the tight mobile bar stays clear — phones reach them via the More sheet. */}
      <div className="flex shrink-0 items-center justify-end gap-1.5 sm:gap-2">
        <SocialIconLinks className="hidden lg:flex" />
        <TourButton />
        {/* The header carries ONE switch and only where it applies: Simple ⇄ Advanced,
            on the trade screen. Every other page shows none — the Legacy ⇄ Latest
            deployment switch used to sit here, which put a control about which PROTOCOL
            you're on next to pages that have nothing to do with the choice.

            Desktop only — phones get the same switch from the dock's More sheet, in the
            slot that toggle used to occupy. The wrapper is what enforces "desktop only":
            passing `hidden` to the toggle collided with the `inline-flex` it sets on
            itself (same CSS property, so Tailwind's emit order picked the winner, not
            the class list) and it stayed visible on mobile. */}
        {V2_SIMPLE_ENABLED && isTradeRoute(pathname) && (
          <span className="hidden lg:inline-flex">
            <TradeModeToggle />
          </span>
        )}
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
  grid = false,
}: {
  fallbackLabel: string;
  items: MenuItem[];
  pathname: string;
  /** Lay the menu out as a two-column launcher grid (footer items span full width). */
  grid?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const activeItem = items.find((i) => pathname.startsWith(i.href));

  const tileItems = grid ? items.filter((i) => !i.footer) : items;
  const footerItems = grid ? items.filter((i) => i.footer) : [];

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
          className={`glass-menu popover-in absolute left-0 top-[calc(100%+10px)] z-50 overflow-hidden rounded-2xl p-2 ${
            grid ? 'w-110' : 'w-64'
          }`}
        >
          {grid ? (
            <div className="flex flex-col gap-1.5">
              <div className="grid grid-cols-2 gap-1.5">
                {tileItems.map((item) => (
                  <MenuTile key={item.href} item={item} pathname={pathname} onSelect={() => setOpen(false)} />
                ))}
              </div>
              {footerItems.map((item) => (
                <MenuRow key={item.href} item={item} pathname={pathname} onSelect={() => setOpen(false)} />
              ))}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              {tileItems.map((item) => (
                <MenuRow key={item.href} item={item} pathname={pathname} onSelect={() => setOpen(false)} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Soon chip — the design system's coming-soon marker, shared by rows and tiles. */
function SoonChip() {
  return (
    <span
      className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest"
      style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}
    >
      Soon
    </span>
  );
}

/** A horizontal menu row: icon · (label + description) · optional Soon chip.
 *  Used for the single-column menus (Vault) and the full-width footer of a grid menu (Docs). */
function MenuRow({
  item,
  pathname,
  onSelect,
}: {
  item: MenuItem;
  pathname: string;
  onSelect: () => void;
}) {
  const active = !item.external && pathname.startsWith(item.href);
  const Icon = item.icon;
  const cls = `ctrl-soft flex items-center gap-3 rounded-xl px-3.5 py-3 transition-colors ${
    active ? 'text-text-1' : 'text-text-2 hover:text-text-1'
  }`;
  const body = (
    <>
      <Icon size={16} className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`} />
      <span className="flex flex-1 flex-col gap-1">
        <span className="text-[13px] font-medium leading-none">{item.label}</span>
        <span className="text-[11px] leading-none text-text-3">{item.desc}</span>
      </span>
      {item.soon && <SoonChip />}
      {item.external && <LuArrowUpRight size={14} className="flex-none text-text-3" />}
    </>
  );

  // Off-site links (socials) open in a new tab; internal destinations route.
  if (item.external) {
    return (
      <a href={item.href} target="_blank" rel="noreferrer" role="menuitem" onClick={onSelect} className={cls}>
        {body}
      </a>
    );
  }
  return (
    <Link href={item.href} role="menuitem" onClick={onSelect} aria-current={active ? 'page' : undefined} className={cls}>
      {body}
    </Link>
  );
}

/** A vertical launcher tile: (icon · label · optional Soon) over a wrapping
 *  description. Tiles stretch to equal height within a grid row, so uneven
 *  description lengths stay aligned. */
function MenuTile({
  item,
  pathname,
  onSelect,
}: {
  item: MenuItem;
  pathname: string;
  onSelect: () => void;
}) {
  const active = pathname.startsWith(item.href);
  const Icon = item.icon;
  return (
    <Link
      href={item.href}
      role="menuitem"
      onClick={onSelect}
      aria-current={active ? 'page' : undefined}
      className={`ctrl-soft flex h-full flex-col gap-2 rounded-xl p-3 transition-colors ${
        active ? 'text-text-1' : 'text-text-2 hover:text-text-1'
      }`}
    >
      <span className="flex items-center gap-2">
        <Icon size={16} className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`} />
        <span className="text-[13px] font-medium leading-none">{item.label}</span>
        {item.soon && <span className="ml-auto"><SoonChip /></span>}
      </span>
      <span className="text-[11px] leading-snug text-text-3">{item.desc}</span>
    </Link>
  );
}

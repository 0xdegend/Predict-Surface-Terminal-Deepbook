'use client';

/**
 * V2BottomNav — mobile dock for the Latest deployment, in the exact legacy
 * BottomNav language: a floating frosted glass-dock pill (gliding accent lens
 * under the active tab) with Trade · Portfolio · Vault · Ranks · More, where
 * More slides up the secondary-destinations sheet (Analytics, Quests,
 * Competitions, Docs). Hidden at lg+ where the header nav takes over.
 *
 * The sheet also carries the phone's ONE switch, Easy ⇄ Pro, and only on the
 * trade routes where it applies. It replaced the Legacy ⇄ Latest toggle that used to
 * head the sheet: a control about which PROTOCOL you're on, offered on every page,
 * when the switch traders actually reach for is between the two trade screens. That
 * one used to sit as a full-width bar at the top of both trade screens, where it ate
 * the first band of a phone screen on the one view that needs its vertical space most.
 *
 * Sibling of the chrome (not nested) so its fixed positioning anchors to the
 * viewport, not a backdrop-filter container. iOS safe-area aware.
 */
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  LuActivity,
  LuWallet,
  LuVault,
  LuTrophy,
  LuLayoutGrid,
  LuArrowUpRight,
} from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useMobileSheetStore } from '@/lib/store/mobile-sheet-store';
import { useTradeViewStore, tradeHref, isTradeRoute } from '@/lib/store/trade-view-store';
import { useMounted } from '@/lib/hooks/use-mounted';
import { V2_SIMPLE_ENABLED } from '@/config/predict';
import { TradeModeToggle } from './trade-mode-toggle';
import { IcoAnalytics, IcoArena, IcoAutopilot, IcoDocs, IcoKelly, IcoOptions, IcoQuests, IcoRecord, IcoRisk } from './nav-icons';
import { SOCIAL_ICON } from '../social-links';
import { SOCIALS } from '@/config/socials';

const PRIMARY: { href: string; label: string; icon: IconType; match: (p: string) => boolean }[] = [
  { href: '/v2', label: 'Trade', icon: LuActivity, match: (p) => isTradeRoute(p) },
  { href: '/v2/portfolio', label: 'Portfolio', icon: LuWallet, match: (p) => p.startsWith('/v2/portfolio') },
  { href: '/v2/vault', label: 'Vault', icon: LuVault, match: (p) => p.startsWith('/v2/vault') },
  { href: '/v2/leaderboard', label: 'Ranks', icon: LuTrophy, match: (p) => p.startsWith('/v2/leaderboard') },
];

type MoreItem = { href: string; label: string; desc: string; icon: IconType; soon?: boolean; footer?: boolean; external?: boolean };

// Same two flags the desktop More menu gates on, so a released feature cannot be
// reachable from one nav and invisible from the other — which is exactly what happened
// to Kelly's Record: it shipped into the header menu and was never added here.
const KELLY_RECEIPTS = process.env.NEXT_PUBLIC_KELLY_RECEIPTS === '1';
const AUTOPILOT = process.env.NEXT_PUBLIC_AUTOPILOT === '1';

const MORE: MoreItem[] = [
  // Descs kept short so each tile is a single line on mobile (uniform height).
  { href: '/v2/options', label: 'BTC Options', desc: 'Probability ladder', icon: IcoOptions },
  { href: '/v2/copilot', label: 'Kelly', desc: 'Talk to the surface', icon: IcoKelly },
  ...(AUTOPILOT ? [{ href: '/v2/autopilot', label: 'Autopilot', desc: 'Trades your rules', icon: IcoAutopilot } as MoreItem] : []),
  ...(KELLY_RECEIPTS
    ? [{ href: '/v2/track-record', label: "Kelly's Record", desc: 'Every call, signed', icon: IcoRecord } as MoreItem]
    : []),
  { href: '/v2/risk', label: 'Vault Risk', desc: 'Pool health & safety', icon: IcoRisk },
  { href: '/v2/analytics', label: 'Analytics', desc: 'Markets & activity', icon: IcoAnalytics },
  { href: '/v2/quests', label: 'Quests', desc: 'Earn DUSDC', icon: IcoQuests, soon: true },
  { href: '/v2/competitions', label: 'Degen Arena', desc: 'Factions clash', icon: IcoArena, soon: true },
  // Reference, not a destination tile → full-width footer row (keeps the grid even).
  { href: '/v2/docs', label: 'Docs', desc: 'How to trade · read the surface', icon: IcoDocs, footer: true },
  // Socials — off-site footer rows, one per account, from the shared list.
  ...SOCIALS.map((s): MoreItem => ({
    href: s.url,
    label: `Follow on ${s.label}`,
    desc: s.handle,
    icon: SOCIAL_ICON[s.id],
    footer: true,
    external: true,
  })),
];

export function V2BottomNav() {
  const pathname = usePathname() ?? '';
  const [open, setOpen] = useState(false);
  // "Trade" opens the remembered simple/advanced view (mounted-guarded; inert
  // unless V2_SIMPLE_ENABLED).
  const tradeView = useTradeViewStore((s) => s.view);
  const mounted = useMounted();
  const tradeTarget = V2_SIMPLE_ENABLED && mounted ? tradeHref(tradeView, true) : '/v2';
  // The mobile trade sheet slides up over this dock — tuck the dock away while
  // it's open so it doesn't float on top of the ticket (legacy BottomNav parity).
  const ticketSheetOpen = useV2TradeStore((s) => s.ticketSheetOpen);
  const closeTicketSheet = useV2TradeStore((s) => s.closeTicketSheet);
  // Any OTHER bottom sheet (simple mode's bet drawer) raises this. Same tuck, separate
  // signal — see [[lib/store/mobile-sheet-store]] for why it isn't the flag above.
  const sheetOpen = useMobileSheetStore((s) => s.sheetOpen);
  const tucked = ticketSheetOpen || sheetOpen;

  // Close the sheet on any navigation (a primary tab, browser back/forward, …) —
  // the nav persists across routes, so it would otherwise linger over the new
  // page. Reset during render (React's "adjust state on change" pattern), not in
  // an effect, so the sheet never paints over the new route first.
  const [navPath, setNavPath] = useState(pathname);
  if (navPath !== pathname) {
    setNavPath(pathname);
    setOpen(false);
  }

  // Clear the SHARED trade-ticket flag when LEAVING the trade screen. It lives in the
  // global store and the dock reads it to translate itself away, so a ticket left "open"
  // in the store on any page that ISN'T the trade screen would strand this dock off-screen
  // (it never rendered a sheet to cover it). The sheet only ever lives on /v2, so dismiss
  // it whenever the destination is anywhere else.
  //
  // Do NOT dismiss when the destination IS /v2: Kelly (via the dock or co-pilot), a shared
  // trade link, and copy-trade all prime the ticket, flip this flag on, then route here to
  // show it — clearing on arrival raced that open and the sheet silently never appeared
  // ("closes the drawer and doesn't open the trade"). Guarding on the destination keeps the
  // off-screen cleanup without clobbering a deliberate cross-screen open. Effect (not a
  // render write) to avoid touching another store mid-render / the purity lint.
  useEffect(() => {
    if (pathname !== '/v2') closeTicketSheet();
  }, [pathname, closeTicketSheet]);

  const primaryIndex = PRIMARY.findIndex((t) => t.match(pathname));
  const moreActive = MORE.some((m) => pathname.startsWith(m.href));
  // The lens sits under a primary tab, or under "More" (index 4) on its routes —
  // AND while the More sheet is open, so opening More visibly slides the active
  // highlight onto it instead of leaving it stranded under the current page's tab
  // (e.g. Ranks), which reads as if the tap did nothing.
  const activeIndex = open ? 4 : primaryIndex >= 0 ? primaryIndex : moreActive ? 4 : -1;

  // Esc closes the sheet.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Backdrop — dims the page behind the sheet, and a tap anywhere off the sheet closes it.
  // It renders OUTSIDE the <nav> on purpose. The nav carries a translate for its tuck
  // animation, and a `translate` of anything other than `none` makes an element the
  // containing block for its fixed-position children. Nested inside, this button's
  // `fixed inset-0` resolved to the dock's own strip at the bottom of the screen instead of
  // the viewport, so the only thing it covered was the sheet already sitting on top of it:
  // a tap on the page above the sheet never reached it, and the only way out was to hit
  // "More" a second time. As a sibling it spans the viewport — over the sticky header
  // (z-40) so even a tap up there dismisses, under the dock (z-50) so the tabs stay live.
  return (
    <>
      {open && (
        <button
          type="button"
          aria-label="Close menu"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-[45] bg-[rgba(8,9,11,0.66)] lg:hidden"
          style={{ animation: 'fadeIn 0.2s ease' }}
        />
      )}

      <nav
        aria-label="Primary"
        aria-hidden={tucked}
        className={`v2-dock pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center px-3 pb-[calc(env(safe-area-inset-bottom)+0.6rem)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:hidden ${
          tucked ? 'translate-y-[130%]' : 'translate-y-0'
        }`}
      >
        {/* The "More" sheet — just above the dock, same width + glass language. */}
        {open && (
          <div
            role="menu"
            className="glass-dock sheet-in pointer-events-auto mb-2.5 w-full max-w-md overflow-hidden rounded-[22px] p-2"
          >
            {/* Capped height so the sheet can never swallow the whole screen on
                small phones — it scrolls internally past that. */}
            <div className="flex max-h-[72vh] flex-col gap-1.5 overflow-y-auto scroll-quiet">
              {/* Easy ⇄ Pro — the desktop header toggle's mobile home. Only on the
                  trade routes it applies to; everywhere else the sheet opens straight into
                  the destinations, with no dead section heading. */}
              {V2_SIMPLE_ENABLED && isTradeRoute(pathname) && (
                <>
                  <span className="px-1.5 pt-1 text-[11px] font-medium text-text-3">Trade mode</span>
                  <TradeModeToggle variant="full" onSelect={() => setOpen(false)} />
                  <div className="my-1 h-px bg-line" />
                </>
              )}
              {/* Destinations in a 2-column grid — halves the sheet's height vs a
                  single stack, so it stops covering most of the screen. */}
              <div className="grid grid-cols-2 gap-2">
                {MORE.filter((m) => !m.footer).map((item) => {
                  const active = pathname.startsWith(item.href);
                  const Icon = item.icon;
                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      role="menuitem"
                      onClick={() => setOpen(false)}
                      aria-current={active ? 'page' : undefined}
                      className={`group ctrl-soft flex h-full min-w-0 flex-col gap-1 rounded-2xl px-3 py-2.5 transition-colors ${
                        active ? 'text-text-1' : 'text-text-2'
                      }`}
                    >
                      <span className="flex items-center justify-between">
                        <Icon size={16} className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`} />
                        {item.soon && (
                          <span
                            className="rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-widest"
                            style={{ color: 'var(--warn)', background: 'var(--warn-soft)' }}
                          >
                            Soon
                          </span>
                        )}
                      </span>
                      <span className="truncate text-[12.5px] font-medium leading-none">{item.label}</span>
                      <span className="truncate text-[10px] leading-none text-text-3">{item.desc}</span>
                    </Link>
                  );
                })}
              </div>
              {/* Full-width footer row(s) — Docs, then socials. */}
              {MORE.filter((m) => m.footer).map((item) => {
                const active = !item.external && pathname.startsWith(item.href);
                const Icon = item.icon;
                const cls = `group ctrl-soft flex items-center gap-2.5 rounded-2xl px-3.5 py-2.5 transition-colors ${
                  active ? 'text-text-1' : 'text-text-2'
                }`;
                const body = (
                  <>
                    <Icon size={17} className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`} />
                    <span className="text-[12.5px] font-medium leading-none">{item.label}</span>
                    <span className="text-[10.5px] leading-none text-text-3">{item.desc}</span>
                    {item.external && <LuArrowUpRight size={15} className="ml-auto flex-none text-text-3" />}
                  </>
                );
                // Off-site links (socials) open in a new tab; internal destinations route.
                return item.external ? (
                  <a
                    key={item.href}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    className={cls}
                  >
                    {body}
                  </a>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    role="menuitem"
                    onClick={() => setOpen(false)}
                    aria-current={active ? 'page' : undefined}
                    className={cls}
                  >
                    {body}
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
            const onPage = tab.match(pathname);
            // While the More sheet is open it owns the active state (its lens has
            // moved onto it), so dim the current page's tab — but aria-current still
            // marks the real page for assistive tech.
            const active = onPage && !open;
            const Icon = tab.icon;
            const href = tab.label === 'Trade' && V2_SIMPLE_ENABLED ? tradeTarget : tab.href;
            return (
              <Link
                key={tab.label}
                href={href}
                onClick={() => setOpen(false)}
                aria-current={onPage ? 'page' : undefined}
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

          {/* More — opens the secondary-destinations sheet. */}
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
    </>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LuChevronDown, LuTarget, LuSwords, LuBookOpen } from 'react-icons/lu';
import type { IconType } from 'react-icons';

/**
 * Desktop nav "More" group (§10.5). The remaining secondary destinations — the
 * Quests/Competitions gamification roadmap and the Docs manual — collapse into
 * one dropdown so the top nav keeps just the primary screens (Trade · Portfolio
 * · Analytics · Leaderboard) plus the Vault group, and leaves room for the
 * wallet. The trigger adopts the active sub-page's label so the current location
 * is never hidden behind a generic word. Client-only (open state + route-derived
 * active). Shown only at lg+; mobile uses BottomNav.
 */
const ITEMS: { href: string; label: string; desc: string; icon: IconType; soon?: boolean }[] = [
  { href: '/quests', label: 'Quests', desc: 'Trade milestones · earn DUSDC', icon: LuTarget, soon: true },
  { href: '/competitions', label: 'Competitions', desc: 'Seasonal races · prize pools', icon: LuSwords, soon: true },
  { href: '/docs', label: 'Docs', desc: 'How to trade · read the surface', icon: LuBookOpen },
];

export function NavMore() {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const activeItem = ITEMS.find((i) => pathname.startsWith(i.href));

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
        className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
          activeItem
            ? 'bg-[var(--accent-soft)] text-text-1'
            : 'text-text-2 hover:bg-white/[0.04] hover:text-text-1'
        }`}
      >
        {activeItem ? activeItem.label : 'More'}
        <LuChevronDown
          size={13}
          className={`text-text-3 transition-transform duration-150 ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="glass-menu popover-in absolute left-0 top-[calc(100%+10px)] z-50 w-64 overflow-hidden rounded-2xl p-2"
        >
          <div className="flex flex-col gap-1.5">
            {ITEMS.map((item) => {
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
                  <Icon
                    size={16}
                    className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`}
                  />
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

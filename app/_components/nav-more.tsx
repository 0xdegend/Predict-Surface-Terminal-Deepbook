'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { LuChevronDown, LuVault, LuShieldAlert, LuKeyRound } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { useAdminCap } from '@/lib/hooks/use-admin-cap';

/**
 * Desktop nav "Vault" group (§10.5). The two vault-facing screens — Hedge Vault
 * (LP) and Vault Risk (exposure/stress) — collapse into one dropdown so the top
 * nav keeps just the primary destinations (Trade · Portfolio · Leaderboard) and
 * leaves room for the wallet. The trigger adopts the active sub-page's label so
 * the current location is never hidden behind a generic word. Client-only
 * (open state + route-derived active). Shown only at lg+; mobile uses BottomNav.
 */
const ITEMS: { href: string; label: string; desc: string; icon: IconType }[] = [
  { href: '/vault', label: 'Vault', desc: 'Add funds · earn a share of fees', icon: LuVault },
  { href: '/risk', label: 'Vault Risk', desc: 'Pool health & safety check', icon: LuShieldAlert },
];

export function NavMore() {
  const pathname = usePathname() ?? '/';
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // The Fee Admin entry only exists for the wallet that owns the AdminCap — other
  // users never see it (and the page itself is cap-gated regardless).
  const { isAdmin } = useAdminCap();
  const items = isAdmin
    ? [...ITEMS, { href: '/admin', label: 'Fee Admin', desc: 'Builder fee · treasury', icon: LuKeyRound }]
    : ITEMS;

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
        className={`flex items-center gap-1 rounded-md px-2.5 py-1.5 text-[12px] font-medium tracking-tight transition-colors ${
          activeItem
            ? 'bg-[var(--accent-soft)] text-text-1'
            : 'text-text-2 hover:bg-white/[0.04] hover:text-text-1'
        }`}
      >
        {activeItem ? activeItem.label : 'Vault'}
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
                  <Icon
                    size={16}
                    className={`flex-none ${active ? 'text-accent' : 'text-text-3'}`}
                  />
                  <span className="flex flex-col gap-1">
                    <span className="text-[13px] font-medium leading-none">{item.label}</span>
                    <span className="text-[11px] leading-none text-text-3">{item.desc}</span>
                  </span>
                </Link>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

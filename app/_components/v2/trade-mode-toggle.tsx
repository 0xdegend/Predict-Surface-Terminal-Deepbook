'use client';

/**
 * TradeModeToggle — the Simple ⇄ Advanced switch, and the ONLY switch in the Latest
 * header. It routes between the two trade experiences — Simple = `/v2/simple` (the calm
 * UP/DOWN round view), Advanced = `/v2` (the full terminal) — and remembers the choice
 * in the trade-view store so the Trade tab reopens where the trader left.
 *
 * Deliberately NOT the DeploymentToggle: that switches PROTOCOL deployment (Legacy ↔
 * Latest, now reached from the More menu / mobile sheet rather than the header). This
 * only swaps front-end complexity within Latest, so every other page is untouched.
 *
 * It wears the SAME control language as that toggle, though — a recessed frosted track,
 * two segments that carry an icon, a label and a small lowercase note, accent glass on
 * the live side, and a centre swap-circle floating over the seam. Two controls that do
 * the same KIND of job should look like siblings; the only thing separating them is
 * which pages they appear on.
 *
 * Variants: "bar" (the desktop header — the chrome wraps it to gate visibility, so this
 * sets no display breakpoints of its own) and "full" (a full-width, touch-sized bar at
 * the top of both trade screens, which is the whole switch on a phone).
 *
 * Active side is read from the pathname (SSR-consistent), so no mounted guard is needed.
 * See [[simple-mode]].
 */
import { usePathname, useRouter } from 'next/navigation';
import { LuZap, LuSlidersHorizontal, LuArrowLeftRight } from 'react-icons/lu';
import { useTradeViewStore } from '@/lib/store/trade-view-store';
import type { IconType } from 'react-icons';

type Variant = 'bar' | 'full';

const OPTIONS: {
  simple: boolean;
  label: string;
  href: string;
  Icon: IconType;
  /** The small lowercase line under the label — who the mode is for, in one word. */
  note: string;
  hint: string;
}[] = [
  {
    simple: true,
    label: 'Simple',
    href: '/v2/simple',
    Icon: LuZap,
    note: 'easy',
    hint: 'Up or down on a timed round — pick an amount and a direction, nothing else.',
  },
  {
    simple: false,
    label: 'Advanced',
    href: '/v2',
    Icon: LuSlidersHorizontal,
    note: 'pro',
    hint: 'The full terminal — strikes, ranges, leverage and the 3-D volatility surface.',
  },
];

// Per-variant sizing. The markup (two segments + centre swap-circle) is shared; only
// the dimensions differ. Mirrors DeploymentToggle's bar/sheet pair.
const SIZES = {
  bar: {
    track: 'inline-flex h-9 shrink-0 rounded-full',
    icon: 14,
    label: 'text-[11px]',
    note: 'text-[8px]',
    padL: 'pl-3 pr-6',
    padR: 'pl-6 pr-3',
    circle: 'h-7 w-7',
    circleIcon: 12,
  },
  full: {
    track: 'flex h-12 w-full rounded-2xl',
    icon: 16,
    label: 'text-[13px]',
    note: 'text-[9px]',
    padL: 'pl-4 pr-9',
    padR: 'pl-9 pr-4',
    circle: 'h-9 w-9',
    circleIcon: 14,
  },
} satisfies Record<Variant, Record<string, unknown>>;

export function TradeModeToggle({
  variant = 'bar',
  className = '',
}: {
  variant?: Variant;
  className?: string;
}) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const setView = useTradeViewStore((s) => s.setView);
  const onSimple = pathname.startsWith('/v2/simple');
  const sz = SIZES[variant];

  function choose(simple: boolean, href: string) {
    setView(simple ? 'simple' : 'advanced');
    if (simple !== onSimple) router.push(href);
  }

  // The centre swap-circle always flips to whichever side isn't active.
  const other = OPTIONS.find((o) => o.simple !== onSimple)!;

  return (
    <div
      role="radiogroup"
      aria-label="Trade mode"
      // shrink-0 so it never crushes header neighbours (bar variant).
      className={`relative select-none items-stretch backdrop-blur-md backdrop-saturate-150 ${sz.track} ${className}`}
      style={{
        // Recessed frosted track — translucent fill + soft inner shadow for depth, no
        // hard border (matches the .glass language).
        background: 'color-mix(in srgb, var(--bg-2) 55%, transparent)',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.28)',
      }}
    >
      {OPTIONS.map((opt, i) => {
        const isActive = opt.simple === onSimple;
        const isLeft = i === 0;
        const { Icon } = opt;
        return (
          <button
            key={opt.label}
            type="button"
            role="radio"
            aria-checked={isActive}
            title={opt.hint}
            onClick={() => choose(opt.simple, opt.href)}
            className={`group relative z-0 flex flex-1 items-center gap-2 transition-colors ${
              isLeft ? `justify-start rounded-l-full rounded-r-lg ${sz.padL}` : `justify-end rounded-r-full rounded-l-lg ${sz.padR}`
            }`}
            style={
              isActive
                ? {
                    // Accent glass fill for the live side + a faint accent glow.
                    background:
                      'linear-gradient(180deg, color-mix(in srgb, var(--accent) 16%, transparent), var(--accent-soft))',
                    boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.06), 0 0 16px -6px var(--accent-glow)',
                  }
                : undefined
            }
          >
            <Icon
              size={sz.icon}
              className={`shrink-0 transition-colors ${isActive ? 'text-accent' : 'text-text-3 group-hover:text-text-2'}`}
            />
            <span className="flex flex-col gap-px leading-none">
              <span
                className={`font-mono ${sz.label} tracking-tight transition-colors ${
                  isActive ? 'text-text-1' : 'text-text-2 group-hover:text-text-1'
                }`}
              >
                {opt.label}
              </span>
              <span
                className={`inline-flex items-center font-medium lowercase leading-none tracking-[0.14em] ${sz.note} ${
                  isActive ? 'text-accent' : 'text-text-3'
                }`}
              >
                {opt.note}
              </span>
            </span>
          </button>
        );
      })}

      {/* Centre swap-circle — floats over the seam, flips to the other mode. Frosted
          accent glass + the one sanctioned off-canvas glow. */}
      <button
        type="button"
        aria-label={`Switch to ${other.label}`}
        title={`Switch to ${other.label}`}
        onClick={() => choose(other.simple, other.href)}
        className={`absolute left-1/2 top-1/2 z-10 flex -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full backdrop-blur-sm transition-transform hover:scale-105 active:scale-95 ${sz.circle}`}
        style={{
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--accent) 22%, transparent), color-mix(in srgb, var(--accent) 6%, transparent))',
          border: '1px solid var(--accent-line)',
          boxShadow: '0 0 14px -4px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.12)',
        }}
      >
        <LuArrowLeftRight size={sz.circleIcon} className="text-accent" />
      </button>
    </div>
  );
}

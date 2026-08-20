'use client';

/**
 * TradeModeToggle — the Simple ⇄ Advanced switch that lives ONLY on the trade
 * screen (the header on desktop, a full-width bar atop the screen on mobile). It
 * routes between the two trade experiences — Simple = `/v2/simple` (the calm
 * UP/DOWN round view), Advanced = `/v2` (the full terminal) — and remembers the
 * choice in the trade-view store so the Trade tab reopens where the trader left.
 *
 * Deliberately NOT the DeploymentToggle: that switches PROTOCOL deployment
 * (Legacy ↔ Latest, which still lives in the More sheet). This only swaps the
 * front-end complexity within Latest, so every other page is untouched. Active
 * side is read from the pathname (SSR-consistent), so no mounted guard is needed.
 * See [[simple-mode]].
 */
import { usePathname, useRouter } from 'next/navigation';
import { LuZap, LuSlidersHorizontal } from 'react-icons/lu';
import { useTradeViewStore } from '@/lib/store/trade-view-store';

const OPTIONS = [
  { simple: true, label: 'Simple', href: '/v2/simple', Icon: LuZap },
  { simple: false, label: 'Advanced', href: '/v2', Icon: LuSlidersHorizontal },
] as const;

export function TradeModeToggle({
  variant = 'bar',
  className = '',
}: {
  /** 'bar' = the compact header pill; 'full' = a full-width bar (mobile screen-top). */
  variant?: 'bar' | 'full';
  className?: string;
}) {
  const pathname = usePathname() ?? '';
  const router = useRouter();
  const setView = useTradeViewStore((s) => s.setView);
  const onSimple = pathname.startsWith('/v2/simple');

  function choose(simple: boolean, href: string) {
    setView(simple ? 'simple' : 'advanced');
    if (simple !== onSimple) router.push(href);
  }

  const full = variant === 'full';

  return (
    <div
      role="radiogroup"
      aria-label="Trade mode"
      className={`relative inline-flex ${full ? 'h-11 w-full' : 'h-9 w-44'} shrink-0 select-none items-stretch rounded-full p-[3px] backdrop-blur-md ${className}`}
      style={{
        background: 'color-mix(in srgb, var(--bg-2) 55%, transparent)',
        boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.28)',
      }}
    >
      {/* sliding accent thumb — lands on the active side */}
      <span
        aria-hidden
        className="absolute bottom-[3px] top-[3px] w-[calc(50%-3px)] rounded-full transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]"
        style={{
          left: 3,
          transform: onSimple ? 'translateX(0)' : 'translateX(100%)',
          background:
            'linear-gradient(180deg, color-mix(in srgb, var(--accent) 20%, transparent), color-mix(in srgb, var(--accent) 7%, transparent))',
          border: '1px solid var(--accent-line)',
          boxShadow: '0 0 16px -6px var(--accent-glow), inset 0 1px 0 rgba(255,255,255,0.10)',
        }}
      />
      {OPTIONS.map((o) => {
        const active = o.simple === onSimple;
        const { Icon } = o;
        return (
          <button
            key={o.label}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => choose(o.simple, o.href)}
            className={`relative z-10 flex flex-1 items-center justify-center gap-1.5 rounded-full ${full ? 'text-[13px]' : 'text-[12px]'} font-medium tracking-tight transition-colors ${
              active ? 'text-text-1' : 'text-text-2 hover:text-text-1'
            }`}
          >
            <Icon size={full ? 14 : 12} className={active ? 'text-accent' : 'text-text-3'} />
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

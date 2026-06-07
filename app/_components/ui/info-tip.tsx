'use client';

/**
 * InfoTip — a small "?" affordance that reveals a plain-language explanation on
 * hover or keyboard focus. Lets the precise term stay for experts while newcomers
 * can learn it. Rendered as a frosted-glass bubble above the icon.
 */
import { LuInfo } from 'react-icons/lu';

export function InfoTip({
  label,
  children,
  size = 11,
}: {
  label: string;
  children: React.ReactNode;
  size?: number;
}) {
  return (
    <span className="group relative inline-flex align-middle">
      <button
        type="button"
        aria-label={`What is ${label}?`}
        className="inline-flex text-text-3 transition-colors hover:text-text-2 focus-visible:text-text-2 focus-visible:outline-none"
      >
        <LuInfo size={size} />
      </button>
      <span
        role="tooltip"
        className="glass pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-52 max-w-[13rem] -translate-x-1/2 rounded-lg p-2.5 text-left text-[10px] font-normal normal-case leading-relaxed tracking-normal text-text-2 shadow-[0_12px_30px_-12px_rgba(0,0,0,0.8)] group-hover:block group-focus-within:block"
      >
        {children}
      </span>
    </span>
  );
}

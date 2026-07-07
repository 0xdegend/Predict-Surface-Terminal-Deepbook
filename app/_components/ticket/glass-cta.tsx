'use client';

/**
 * GlassCta — the big glass step-advance button ("Set Amount") shared by the
 * legacy FlowPanel and the v2 trade ticket: frosted card with a top-edge sheen
 * and an accent bloom on hover.
 */
export function GlassCta({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="group relative flex items-center justify-center gap-2 overflow-hidden rounded-xl border border-white/10 bg-white/4 px-3 py-3.5 text-[13px] font-semibold text-text-1 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.07),0_10px_30px_-14px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-all duration-200 hover:border-(--accent-line) hover:text-up hover:shadow-[inset_0_1px_0_0_rgba(255,255,255,0.1),0_0_30px_-8px_var(--accent-glow)] disabled:cursor-not-allowed disabled:border-line disabled:bg-white/2 disabled:text-text-3 disabled:shadow-none disabled:backdrop-blur-none"
    >
      {/* top-edge sheen — the glass highlight */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/20 to-transparent transition-opacity group-hover:via-white/30 group-disabled:opacity-0"
      />
      {/* accent wash bloom on hover */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 opacity-0 transition-opacity duration-200 group-hover:opacity-100 group-disabled:opacity-0"
        style={{
          background:
            'radial-gradient(120% 120% at 50% 0%, var(--accent-soft), transparent 62%)',
        }}
      />
      <span className="relative">{children}</span>
    </button>
  );
}

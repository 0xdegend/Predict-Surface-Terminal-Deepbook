'use client';

/**
 * ReviewButton — the primary mint/review action, shared by the legacy
 * FlowPanel and the v2 trade ticket. Glows with the side's tone (UP teal /
 * DOWN coral) via a soft gradient; falls back to a quiet disabled state.
 */
export function ReviewButton({
  tone,
  onClick,
  disabled,
  children,
}: {
  tone: 'up' | 'down';
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`group relative flex items-center justify-center gap-2 overflow-hidden rounded-lg border bg-linear-to-b px-3 py-3 text-[13px] font-semibold transition-all disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3 disabled:shadow-none ${
        tone === 'up'
          ? 'border-up/50 from-up/25 to-up/10 text-up shadow-[0_0_24px_-6px_var(--accent-glow)] hover:from-up/35 hover:to-up/15 hover:shadow-[0_0_30px_-4px_var(--accent-glow)]'
          : 'border-down/50 from-down/25 to-down/10 text-down shadow-[0_0_24px_-6px_rgba(240,121,107,0.3)] hover:from-down/35 hover:to-down/15 hover:shadow-[0_0_30px_-4px_rgba(240,121,107,0.34)]'
      }`}
    >
      {children}
    </button>
  );
}

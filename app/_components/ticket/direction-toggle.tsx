'use client';

/**
 * DirectionToggle — the UP/DOWN side picker, shared by the legacy FlowPanel and
 * the v2 trade ticket. Single-line glyph + label; the live odds live in the
 * odds panel / risk-reward card, NOT here (user decision 2026-07-08).
 */
export function DirectionToggle({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'up' | 'down';
  children: React.ReactNode;
}) {
  const glyph = tone === 'up' ? '▲' : '▼';
  const activeCls =
    tone === 'up'
      ? 'border border-up/50 bg-(--accent-soft) text-up shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_0_22px_-8px_var(--accent-glow)]'
      : 'border border-down/50 bg-(--down-soft) text-down shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_0_22px_-8px_rgba(240,121,107,0.3)]';
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-semibold tracking-wide transition-all ${
        active ? activeCls : 'ctrl-soft text-text-3'
      }`}
    >
      <span className="text-[9px]">{glyph}</span>
      {children}
    </button>
  );
}

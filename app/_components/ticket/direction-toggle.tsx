'use client';

/**
 * DirectionToggle — the UP/DOWN side picker, shared by the legacy FlowPanel and
 * the v2 trade ticket. Optional `sub` renders the live fair odds under the
 * label (e.g. "49.0%") so the trader sees what each side is pricing at before
 * committing to one.
 */
export function DirectionToggle({
  active,
  onClick,
  tone,
  sub,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'up' | 'down';
  /** Optional live odds readout under the label. */
  sub?: string;
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
      className={`flex flex-1 flex-col items-center justify-center gap-0.5 rounded-lg py-2.5 transition-all ${
        active ? activeCls : 'ctrl-soft text-text-3'
      }`}
    >
      <span className="flex items-center gap-1.5 text-[13px] font-semibold tracking-wide">
        <span className="text-[9px]">{glyph}</span>
        {children}
      </span>
      {sub && (
        <span
          className={`font-mono text-[10px] tabular-nums ${active ? 'opacity-70' : 'text-text-3'}`}
        >
          {sub}
        </span>
      )}
    </button>
  );
}

/**
 * SampleBadge — the honest "this is illustrative, not live" tag used across the
 * v2 Analytics sample sections (warn token, same language as the Quests/
 * Competitions "Soon" chips). Never let sample data read as real flow.
 */
export function SampleBadge({ label = 'Sample data' }: { label?: string }) {
  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.12em]"
      style={{
        color: 'var(--warn)',
        background: 'var(--warn-soft)',
        border: '1px solid color-mix(in srgb, var(--warn) 28%, transparent)',
      }}
    >
      <span aria-hidden className="h-1.5 w-1.5 rounded-full" style={{ background: 'var(--warn)' }} />
      {label}
    </span>
  );
}

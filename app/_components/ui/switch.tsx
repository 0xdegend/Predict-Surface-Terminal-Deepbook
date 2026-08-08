'use client';

/**
 * Switch — a small on/off toggle in the terminal's control language. One accessible
 * `role="switch"` button; the knob slides across the track. Uses the canonical
 * inline-flex + inline-block + translate pattern so the knob is anchored at the track
 * start and can never overflow the track (an absolutely-positioned knob could).
 */
export function Switch({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  /** Accessible name for the control (there's no visible text inside the switch). */
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-10 shrink-0 cursor-pointer items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${
        checked ? 'bg-up/70' : 'bg-white/15'
      }`}
    >
      {/* Track 40px, knob 16px, 4px inset both ends: off = translate-x-1, on = translate-x-5. */}
      <span
        className={`inline-block h-4 w-4 transform rounded-full bg-white shadow-sm transition-transform duration-200 ${
          checked ? 'translate-x-5' : 'translate-x-1'
        }`}
      />
    </button>
  );
}

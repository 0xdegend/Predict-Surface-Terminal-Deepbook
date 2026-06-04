import type { IconType } from 'react-icons';

/**
 * Shared glass-metric primitives. Muted, desaturated icon hues give the metric
 * grids enough variety to read at a glance without competing with the surface's
 * IV ramp; teal/coral reuse the semantic up/down tokens.
 */
export const HUE = {
  teal: '#4dd6b0',
  violet: '#9d92e8',
  blue: '#6aa6e6',
  amber: '#d9a94e',
  coral: '#f0796b',
};

/** A tinted, rounded icon chip — the per-metric color treatment. */
export function IconChip({
  icon: Icon,
  color,
  size = 26,
}: {
  icon: IconType;
  color: string;
  size?: number;
}) {
  return (
    <span
      className="inline-flex flex-none items-center justify-center rounded-lg"
      style={{
        width: size,
        height: size,
        color,
        background: `color-mix(in srgb, ${color} 15%, transparent)`,
      }}
    >
      <Icon size={Math.round(size * 0.55)} />
    </span>
  );
}

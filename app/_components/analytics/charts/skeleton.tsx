/**
 * Skeleton — a single shimmering placeholder block. Compose these to mirror a
 * panel's final layout while it loads (no spinners on blank, per §10.7).
 */
export function Skeleton({ className = '' }: { className?: string }) {
  // Default `rounded`; a larger radius passed in className (rounded-lg/full) wins.
  return <span className={`skeleton block rounded ${className}`} aria-hidden />;
}

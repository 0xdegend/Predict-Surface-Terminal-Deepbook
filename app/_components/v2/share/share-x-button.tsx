'use client';

/**
 * ShareXButton — a small ghost "Share to X" icon button used to open a share-card
 * dialog from a widget. Stops propagation so a share click never also triggers a
 * clickable parent (e.g. a ladder row's select).
 */
import { FaXTwitter } from 'react-icons/fa6';

export function ShareXButton({
  onClick,
  label = 'Share to X',
  className = '',
}: {
  onClick: () => void;
  label?: string;
  className?: string;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={`ctrl-soft grid h-7 w-7 flex-none place-items-center rounded-lg text-text-3 transition-colors hover:text-text-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 ${className}`}
    >
      <FaXTwitter size={12} />
    </button>
  );
}

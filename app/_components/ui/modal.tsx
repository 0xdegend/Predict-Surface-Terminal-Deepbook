'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

/**
 * Minimal accessible modal: backdrop blur, ESC + backdrop-click to close, body
 * scroll-lock, focus moved into the panel and restored on close. Entrance fade
 * is skipped under reduced motion. Renders nothing when closed.
 *
 * Rendered through a portal to <body> so it overlays the whole viewport — a
 * caller's `backdrop-filter`/`transform`/`overflow-hidden` ancestor (e.g. the
 * frosted .glass-card) would otherwise become the containing block for our
 * `position: fixed` layer and trap/clip the dialog inside the card.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
  maxWidthClass = 'max-w-md',
  variant = 'solid',
  contentClassName = 'px-4 py-4',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  /** Tailwind max-width for the panel. Defaults to a compact dialog. */
  maxWidthClass?: string;
  /** 'solid' = raised panel; 'glass' = frosted, borderless, larger radius. */
  variant?: 'solid' | 'glass';
  /** Override the content wrapper padding (e.g. for full-bleed layouts). */
  contentClassName?: string;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const lastFocused = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    lastFocused.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog for keyboard users.
    panelRef.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      lastFocused.current?.focus?.();
    };
  }, [open, onClose]);

  // Closed on first render (SSR/hydrate); only portals after a client open.
  if (!open || typeof document === 'undefined') return null;

  const glass = variant === 'glass';
  const panelClass = glass
    ? 'glass rounded-2xl shadow-[0_40px_120px_-30px_rgba(0,0,0,0.9)]'
    : 'rounded-lg border border-line-strong bg-bg-1 shadow-2xl';
  const headerClass = glass
    ? 'flex items-start justify-between px-5 pt-4 pb-3'
    : 'flex items-start justify-between border-b border-line-soft px-4 py-3';
  const footerClass = glass
    ? 'flex items-center justify-end gap-2 px-5 pb-4'
    : 'flex items-center justify-end gap-2 border-t border-line-soft px-4 py-3';

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm motion-safe:animate-[fadeIn_120ms_ease-out]" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className={`scroll-quiet relative max-h-[92vh] w-full overflow-y-auto ${maxWidthClass} ${panelClass} outline-none focus-visible:outline-none motion-safe:animate-[popIn_140ms_ease-out]`}
      >
        {/* faint top-edge highlight — the only "creative" flourish, no hard border */}
        {glass && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-x-6 top-0 h-px bg-linear-to-r from-transparent via-white/15 to-transparent"
          />
        )}
        <div className={headerClass}>
          <div>
            <h2 className="text-[12px] font-medium uppercase tracking-wider text-text-1">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[11px] text-text-3">{subtitle}</p>}
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 rounded p-1 text-text-3 hover:text-text-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong"
          >
            ✕
          </button>
        </div>
        <div className={contentClassName}>{children}</div>
        {footer && <div className={footerClass}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

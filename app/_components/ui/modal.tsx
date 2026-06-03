'use client';

import { useEffect, useRef } from 'react';

/**
 * Minimal accessible modal: backdrop blur, ESC + backdrop-click to close, body
 * scroll-lock, focus moved into the panel and restored on close. Entrance fade
 * is skipped under reduced motion. Renders nothing when closed.
 */
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
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

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      role="presentation"
    >
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm motion-safe:animate-[fadeIn_120ms_ease-out]" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        className="relative w-full max-w-md rounded-lg border border-line-strong bg-bg-1 shadow-2xl outline-none motion-safe:animate-[popIn_140ms_ease-out]"
      >
        <div className="flex items-start justify-between border-b border-line-soft px-4 py-3">
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
        <div className="px-4 py-4">{children}</div>
        {footer && (
          <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-3">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}

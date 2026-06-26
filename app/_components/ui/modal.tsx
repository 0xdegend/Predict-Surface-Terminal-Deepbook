'use client';

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { MascotPeek } from './mascot-peek';
import type { MascotMood } from '@/lib/mascot';

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
  mascot,
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
  /** Opt-in: peek the mascot into the top-right corner, reacting to context.
   *  Only for header-light dialogs — not full-width content (tables, etc.). */
  mascot?: MascotMood;
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
  // Header keeps its left padding; the right padding grows when the mascot peeks
  // in, so the title/subtitle never run under the fox.
  const headerPr = mascot ? 'pr-24' : glass ? 'pr-5' : 'pr-4';
  const headerClass = glass
    ? `relative z-10 flex items-start justify-between pl-5 pt-4 pb-3 ${headerPr}`
    : `relative z-10 flex items-start justify-between border-b border-line-soft pl-4 py-3 ${headerPr}`;
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
        {/* mascot peek — sits behind the header/content (z-0); they're lifted to
            z-10, the close button to z-20+, so it never blocks interaction. */}
        {mascot && <MascotPeek mood={mascot} />}
        {/* Close button. The mascot owns the top-right corner, so with a mascot the
            ✕ moves to the opposite (top-left) corner and the title indents to clear
            it — otherwise they crowd. No mascot → the conventional top-right ✕. */}
        {mascot && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="absolute left-3 top-3 z-30 rounded p-1 text-text-3 hover:text-text-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong"
          >
            ✕
          </button>
        )}
        <div className={headerClass}>
          <div className={mascot ? 'pl-7' : ''}>
            <h2 className="text-[12px] font-medium uppercase tracking-wider text-text-1">{title}</h2>
            {subtitle && <p className="mt-0.5 text-[11px] text-text-3">{subtitle}</p>}
          </div>
          {!mascot && (
            <button
              onClick={onClose}
              aria-label="Close"
              className="relative z-20 -mr-1 rounded p-1 text-text-3 hover:text-text-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-line-strong"
            >
              ✕
            </button>
          )}
        </div>
        <div className={`relative z-10 ${contentClassName}`}>{children}</div>
        {footer && <div className={`relative z-10 ${footerClass}`}>{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

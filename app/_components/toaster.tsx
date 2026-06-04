'use client';

import { useEffect } from 'react';
import { useToastStore, type Toast } from '@/lib/store/toast-store';

/**
 * Toast stack — bottom-right on desktop, full-width bottom on mobile. Renders
 * the redesign's transaction feedback ("Minted · UP", explorer link, errors).
 * Mounted once in the app shell.
 */
export function Toaster() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[100] flex flex-col items-stretch gap-2 p-4 sm:inset-x-auto sm:right-4 sm:bottom-4 sm:w-[360px]">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function ToastCard({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  useEffect(() => {
    if (!toast.ttl) return;
    const t = setTimeout(onDismiss, toast.ttl);
    return () => clearTimeout(t);
  }, [toast.ttl, onDismiss]);

  const accent =
    toast.kind === 'success'
      ? 'text-accent bg-accent'
      : toast.kind === 'error'
        ? 'text-down bg-down'
        : 'text-text-2 bg-text-2';
  const [textCls, dotCls] = accent.split(' ');

  return (
    <div className="popover-in glass pointer-events-auto flex items-start gap-3 rounded-[10px] p-3 shadow-[0_16px_44px_-12px_rgba(0,0,0,0.7)]">
      <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${dotCls}`} />
      <div className="min-w-0 flex-1">
        <div className={`text-[12px] font-medium ${textCls}`}>{toast.title}</div>
        {toast.desc && (
          <div className="mt-0.5 break-words font-mono text-[11px] tabular-nums text-text-3">
            {toast.desc}
          </div>
        )}
        {toast.href && (
          <a
            href={toast.href}
            target="_blank"
            rel="noreferrer"
            className="mt-1 inline-block text-[11px] text-text-2 underline-offset-2 hover:text-text-1 hover:underline"
          >
            View on explorer ↗
          </a>
        )}
      </div>
      <button
        onClick={onDismiss}
        aria-label="Dismiss"
        className="shrink-0 rounded p-0.5 text-text-3 transition-colors hover:text-text-1"
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}

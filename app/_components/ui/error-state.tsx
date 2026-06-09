'use client';

/**
 * Shared server-fetch error panel (redesign Phase 6). A centered, glassmorphic
 * card. When the browser is actually offline (`navigator.onLine === false`) it
 * pivots to a connection-specific message — "check your Wi-Fi" — instead of the
 * generic server-error copy, since that's the most common cause. The raw error
 * stays as a de-emphasized technical footer for support/debugging.
 */
import { useEffect, useState } from 'react';
import { LuWifiOff, LuTriangleAlert } from 'react-icons/lu';
import { RetryButton } from '../retry-button';

export function ErrorState({
  title,
  message,
  detail,
  note,
}: {
  title: string;
  message: string;
  detail?: string;
  note?: string;
}) {
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    const sync = () => setOffline(!navigator.onLine);
    sync();
    window.addEventListener('online', sync);
    window.addEventListener('offline', sync);
    return () => {
      window.removeEventListener('online', sync);
      window.removeEventListener('offline', sync);
    };
  }, []);

  return (
    <div className="flex min-h-[60vh] flex-1 items-center justify-center p-6">
      <div className="glass relative w-full max-w-md overflow-hidden rounded-2xl p-7 text-center shadow-[0_24px_70px_-24px_rgba(0,0,0,0.8)]">
        {/* soft accent wash at the top — amber when offline, coral otherwise */}
        <span
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-0 h-24"
          style={{
            background: offline
              ? 'radial-gradient(80% 100% at 50% 0%, var(--warn-soft), transparent 70%)'
              : 'radial-gradient(80% 100% at 50% 0%, var(--down-soft), transparent 70%)',
          }}
        />

        <div className="relative flex flex-col items-center gap-4">
          <span
            className={`flex h-12 w-12 items-center justify-center rounded-full ring-1 ${
              offline
                ? 'bg-[var(--warn-soft)] text-warn ring-warn/20'
                : 'bg-[var(--down-soft)] text-down ring-down/20'
            }`}
          >
            {offline ? <LuWifiOff size={22} /> : <LuTriangleAlert size={22} />}
          </span>

          <div className="flex flex-col gap-1.5">
            <h2 className="text-[16px] font-semibold tracking-tight text-text-1">
              {offline ? 'You appear to be offline' : title}
            </h2>
            <p className="text-[12px] leading-relaxed text-text-2">
              {offline
                ? 'We couldn’t reach the Predict server. Check your Wi-Fi or network connection, then try again.'
                : (note ?? 'This is usually a brief hiccup — give it another try.')}
            </p>
          </div>

          <RetryButton />

          {/* technical detail — de-emphasized, for support/debugging */}
          <p className="break-words font-mono text-[10px] leading-relaxed text-text-3">
            {message}
            {detail ? ` · ${detail}` : ''}
          </p>
        </div>
      </div>
    </div>
  );
}

'use client';

/**
 * GlassError — the app's error banner: a down-tinted frosted-glass panel (see
 * `.glass-error` in globals.css) with an optional dismiss button. Replaces the
 * flat `border-down/40 bg-down/10` boxes so failures match the glass language
 * and can be cleared. Pass `onDismiss` to show the × (omit it for a persistent,
 * non-dismissable notice).
 *
 * A dismissable banner also clears itself after `autoDismissMs` (default 8s), so
 * a transient action error (a stale market, a rejected signature) doesn't linger
 * once the moment has passed. The timer re-arms only when `message` changes, so
 * frequent parent re-renders (e.g. the ticket's per-second countdown) don't keep
 * resetting it and pin the banner open. Pass `autoDismissMs={0}` to keep an error
 * until the user clears it.
 */
import { useEffect, useRef } from 'react';
import { LuX } from 'react-icons/lu';

export function GlassError({
  message,
  onDismiss,
  autoDismissMs = 8000,
  className = '',
}: {
  message: string;
  onDismiss?: () => void;
  autoDismissMs?: number;
  className?: string;
}) {
  // Hold the latest onDismiss in a ref (synced in an effect, never during render)
  // so the auto-dismiss timer can call it without depending on its identity —
  // callers pass a fresh arrow each render, which would otherwise reset the timer.
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  }, [onDismiss]);

  const dismissable = !!onDismiss;
  useEffect(() => {
    if (!dismissable || autoDismissMs <= 0) return;
    const t = setTimeout(() => onDismissRef.current?.(), autoDismissMs);
    return () => clearTimeout(t);
  }, [message, dismissable, autoDismissMs]);

  return (
    <div
      role="alert"
      className={`glass-error relative flex items-start gap-2 rounded-lg p-2.5 font-mono text-[12px] leading-relaxed text-down ${
        onDismiss ? 'pr-8' : ''
      } ${className}`}
    >
      <span className="min-w-0 flex-1 break-words">{message}</span>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute right-1.5 top-1.5 rounded-md p-1 text-down/70 outline-none transition-colors hover:bg-down/15 hover:text-down focus-visible:ring-2 focus-visible:ring-down/40"
        >
          <LuX size={13} />
        </button>
      )}
    </div>
  );
}

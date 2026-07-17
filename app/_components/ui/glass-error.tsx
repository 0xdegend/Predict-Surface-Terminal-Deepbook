'use client';

/**
 * GlassError — the app's error banner: a down-tinted frosted-glass panel (see
 * `.glass-error` in globals.css) with an optional dismiss button. Replaces the
 * flat `border-down/40 bg-down/10` boxes so failures match the glass language
 * and can be cleared. Pass `onDismiss` to show the × (omit it for a persistent,
 * non-dismissable notice).
 */
import { LuX } from 'react-icons/lu';

export function GlassError({
  message,
  onDismiss,
  className = '',
}: {
  message: string;
  onDismiss?: () => void;
  className?: string;
}) {
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

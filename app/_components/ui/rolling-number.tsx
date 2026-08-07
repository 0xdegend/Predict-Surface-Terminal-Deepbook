'use client';

/**
 * RollingNumber — an odometer readout: each digit is a 0-9 strip that slides
 * vertically to its value, so the number "rolls" like a mechanical counter.
 *
 * Crucially there is NO value tween. `text` is the already-formatted, REAL number,
 * rendered immediately; only each digit's vertical SLIDE animates. So the shown value
 * is never delayed by the animation, and a new value that lands mid-slide just retargets
 * the strips to the newest digits (they glide on, never lag). Non-digit characters
 * ($ , .) are static. Snaps under prefers-reduced-motion. Pair with `tabular-nums` on the
 * parent so digit cells are equal width and nothing shifts as the value changes.
 */
import { memo } from 'react';

const DIGITS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];

/** One character cell: a 1em-tall window. Digits roll inside it; separators sit static. */
const Cell = memo(function Cell({ ch }: { ch: string }) {
  const isDigit = ch >= '0' && ch <= '9';
  return (
    <span className="inline-block overflow-hidden leading-none" style={{ height: '1em' }}>
      {isDigit ? (
        <span
          className="flex flex-col transition-transform duration-150 ease-out motion-reduce:transition-none"
          style={{ transform: `translateY(-${Number(ch)}em)` }}
        >
          {DIGITS.map((n) => (
            <span key={n} className="block shrink-0" style={{ height: '1em', lineHeight: '1em' }}>
              {n}
            </span>
          ))}
        </span>
      ) : (
        <span className="block" style={{ height: '1em', lineHeight: '1em' }}>
          {ch}
        </span>
      )}
    </span>
  );
});

export const RollingNumber = memo(function RollingNumber({
  text,
  className,
}: {
  text: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-end leading-none ${className ?? ''}`} aria-hidden="true">
      {[...text].map((ch, i) => (
        <Cell key={`${i}:${ch >= '0' && ch <= '9' ? 'd' : ch}`} ch={ch} />
      ))}
    </span>
  );
});

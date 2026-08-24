'use client';

/**
 * SurfaceStatement — what the market is doing, said before anyone touches anything.
 *
 * The page used to open on regime pills and a 3-D surface, and then stay quiet until a
 * strike was picked. For a page whose claim is that it renders the best options data in
 * crypto, that is the wrong opening: a data page has to make a statement before it is
 * interacted with, or it reads as a form waiting to be filled in.
 *
 * Everything in the sentence comes off our own surface (see `buildSurfaceHeadline`):
 * the expected move, which side of the smile is dear, the term structure, the basis.
 * No strike, no third-party context, no forecast.
 *
 * Plain gets the sentence and one line telling it what to do next. Pro gets the
 * supporting numbers under it. Nothing is repeated between the two.
 */
import type { SurfaceHeadline } from '@/lib/insights';
import { PlainOnly, useVocab } from './vocab';

export function SurfaceStatement({ headline, loading }: { headline: SurfaceHeadline | null; loading?: boolean }) {
  const { pro } = useVocab();

  if (!headline) {
    return loading ? (
      <div className="mb-3 h-6 w-3/5 animate-pulse rounded bg-white/5" aria-hidden />
    ) : null;
  }

  const accent =
    headline.tone === 'down' ? 'text-down' : headline.tone === 'up' ? 'text-up' : 'text-text-1';

  return (
    <div className="mb-4">
      <p className={`text-[17px] font-medium leading-snug tracking-tight sm:text-[19px] ${accent}`}>
        {headline.text}
      </p>

      {pro && headline.detail.length > 0 && (
        <ul className="mt-2 space-y-1">
          {headline.detail.map((d, i) => (
            <li key={i} className="text-[12.5px] leading-relaxed text-text-2">
              {d}
            </li>
          ))}
        </ul>
      )}

      {/* Plain needs one instruction, not a paragraph explaining the product. */}
      <PlainOnly>
        <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-3">
          Pick a price below to see the chance it happens and what it pays.
        </p>
      </PlainOnly>
    </div>
  );
}

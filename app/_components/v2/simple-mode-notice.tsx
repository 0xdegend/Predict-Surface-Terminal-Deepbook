'use client';

/**
 * SimpleModeNotice — how an existing trader hears that simple mode shipped.
 *
 * The first-visit dialog asks newcomers which screen they want. Someone who has been
 * trading here for weeks shouldn't be asked whether they're new to prediction markets;
 * the only part of it that is news to them is that the other screen now exists. So they
 * get this instead: one line, a link, a dismiss.
 *
 * A STRIP, NOT A TOAST. A toast disappears while you're reading the chart, and the whole
 * point is that they act on it — this is a launch announcement, not a status update. It
 * holds its place until dismissed, and dismissing is permanent.
 *
 * It does NOT block anything: no overlay, no interruption of a trade in progress. It sits
 * above the terminal and can be ignored forever at the cost of one line of height.
 *
 * Shows only on the advanced screen, only to a returning browser ([[lib/store/visitor]]),
 * only while simple mode is on, and never to someone who already answered the first-visit
 * dialog — they have already been told.
 */
import Link from 'next/link';
import { LuX } from 'react-icons/lu';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useTradeViewStore } from '@/lib/store/trade-view-store';
import { visitorKind } from '@/lib/store/visitor';
import { TRADE_MODE_ICON, TRADE_MODE_LABEL } from './trade-mode';
import { V2_SIMPLE_ENABLED } from '@/config/predict';

export function SimpleModeNotice() {
  const mounted = useMounted();
  const chosen = useTradeViewStore((s) => s.chosen);
  const noticeSeen = useTradeViewStore((s) => s.noticeSeen);
  const seeNotice = useTradeViewStore((s) => s.seeNotice);
  const Icon = TRADE_MODE_ICON.simple;

  if (!V2_SIMPLE_ENABLED || !mounted || noticeSeen || chosen) return null;
  if (visitorKind() !== 'returning') return null;

  // Padded on all four sides: the chart starts immediately below, and without the
  // bottom gap the strip reads as part of it rather than as a note above it.
  return (
    <div className="px-4 py-3 sm:px-5">
      <div className="ctrl-soft flex items-center gap-2 rounded-xl px-3 py-2 sm:gap-3 sm:px-3.5 sm:py-2.5">
        <span className="flex h-7 w-7 flex-none items-center justify-center rounded-full border border-(--accent-line) bg-(--accent-soft)">
          <Icon size={14} className="text-accent" />
        </span>
        {/* One line, always. The tail sentence is the part that wraps on a phone and
            pushes the chart down, so small screens get the headline alone; `truncate`
            is the backstop for a narrow phone or a large text-size setting. */}
        <p className="min-w-0 flex-1 truncate text-[12.5px] text-text-2">
          <span className="font-semibold text-text-1">{TRADE_MODE_LABEL.simple} mode is live.</span>
          <span className="hidden sm:inline"> Up or down on a timed round, in two taps.</span>
        </p>
        <Link
          href="/v2/simple"
          onClick={seeNotice}
          className="flex-none rounded-lg border border-(--accent-line) bg-(--accent-soft) px-2.5 py-1.5 text-[12px] font-medium whitespace-nowrap text-up transition-colors hover:bg-up/15 sm:px-3"
        >
          Take a look
        </Link>
        <button
          type="button"
          onClick={seeNotice}
          aria-label="Dismiss"
          className="flex-none rounded-md p-1 text-text-3 transition-colors hover:text-text-1 sm:p-1.5"
        >
          <LuX size={15} />
        </button>
      </div>
    </div>
  );
}

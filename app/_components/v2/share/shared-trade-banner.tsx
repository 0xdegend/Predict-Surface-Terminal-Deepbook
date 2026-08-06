'use client';

/**
 * SharedTradeBanner — the "your friend set this up" note at the top of the trade
 * ticket when the selection was loaded from a shared trade link (see
 * use-v2-open-shared-trade). Reads `sharedContext` from the trade store; renders
 * nothing when the selection is the trader's own. Also surfaces any plain-language
 * "moved to fit this market" adjustments from re-resolution, and lets the trader
 * dismiss the note. It never touches the trade itself — the ticket below is the
 * live, re-quoted trade the trader confirms.
 */
import { LuX } from 'react-icons/lu';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';

export function SharedTradeBanner() {
  const ctx = useV2TradeStore((s) => s.sharedContext);
  const clear = useV2TradeStore((s) => s.setSharedContext);
  if (!ctx) return null;

  const who = ctx.ref ? `${ctx.ref} set this trade up for you` : 'A friend set this trade up for you';

  return (
    <div className="relative rounded-lg border border-line border-l-2 border-l-up/70 bg-up/5 px-3 py-2.5 font-sans">
      <button
        type="button"
        onClick={() => clear(null)}
        aria-label="Dismiss"
        className="absolute right-1.5 top-1.5 rounded p-1 text-text-3 transition-colors hover:text-text-1"
      >
        <LuX size={13} />
      </button>
      <div className="flex items-start gap-2 pr-5">
        <span aria-hidden className="text-[15px] leading-none">
          🦊
        </span>
        <div className="min-w-0">
          <p className="text-[12px] font-medium text-text-1">{who}</p>
          <p className="text-[11px] text-text-3">Review the live price below, then place it if you like.</p>
          {ctx.adjustments.length > 0 && (
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {ctx.adjustments.map((a, i) => (
                <li key={i} className="text-[11px] text-text-2">
                  {a}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

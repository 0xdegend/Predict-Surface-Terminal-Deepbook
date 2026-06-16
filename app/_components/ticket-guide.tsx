'use client';

/**
 * TicketGuide — a plain-language "what do I do here" guide at the top of the
 * trade ticket, for first-time traders (feedback: "I'm not sure what to do").
 * Three short steps that track the live flow: the current step is highlighted
 * and finished ones are checked off, so it doubles as in-context guidance.
 *
 * Shown expanded by default; dismissing it persists (localStorage) so repeat
 * traders aren't nagged, and a quiet "How it works" link reopens it. Only ever
 * rendered after the ticket has mounted (FlowPanel gates on `mounted`), so the
 * lazy localStorage read can't cause a hydration mismatch.
 */
import { useState } from 'react';
import { LuX, LuCircleHelp } from 'react-icons/lu';

const GUIDE_KEY = 'skew:ticket-guide-dismissed';

// Step 1 differs by mode — a binary market is an Up/Down call, a range market is
// a band picked on the odds curve — so the guide never tells a range trader to
// "pick Up or Down". Steps 2–3 are identical.
const GUIDE: Record<'binary' | 'range', { steps: string[]; tip: string }> = {
  binary: {
    steps: [
      'Pick Up or Down and a price level',
      'Enter how much you want to bet',
      'Review and confirm your trade',
    ],
    tip: 'Tip: tap a point on the chart or a market in the list to load it here.',
  },
  range: {
    steps: [
      'Pick your price range on the odds curve above',
      'Enter how much you want to bet',
      'Review and confirm your trade',
    ],
    tip: 'Tip: tap two price levels on the odds curve above to set your band.',
  },
};

export function TicketGuide({ step, mode }: { step: 1 | 2 | 3; mode: 'binary' | 'range' }) {
  const [dismissed, setDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(GUIDE_KEY) === '1';
    } catch {
      return false;
    }
  });

  function dismiss() {
    try {
      localStorage.setItem(GUIDE_KEY, '1');
    } catch {
      /* private mode / storage disabled — just hide for this session */
    }
    setDismissed(true);
  }

  function reopen() {
    try {
      localStorage.removeItem(GUIDE_KEY);
    } catch {
      /* ignore */
    }
    setDismissed(false);
  }

  if (dismissed) {
    // Clear, always-available reopen affordance — a chip with a help icon, so a
    // confused user can pull the steps back up at a glance (not a faint link).
    return (
      <button
        onClick={reopen}
        className="inline-flex items-center gap-1.5 self-start rounded-md border border-line bg-white/3 px-2.5 py-1.5 text-[11px] font-medium text-text-2 transition-colors hover:border-line-strong hover:text-text-1"
      >
        <LuCircleHelp size={13} className="text-accent" />
        How it works
      </button>
    );
  }

  return (
    <div className="glass-card flex flex-col gap-2.5 p-3.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium text-text-1">
          New here? Your first trade in 3 steps
        </span>
        <button
          onClick={dismiss}
          aria-label="Dismiss guide"
          className="ctrl-soft -mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-text-3 transition-colors hover:text-text-1"
        >
          <LuX size={13} />
        </button>
      </div>

      <ol className="flex flex-col gap-1.5">
        {GUIDE[mode].steps.map((label, i) => {
          const n = i + 1;
          const active = n === step;
          const done = n < step;
          return (
            <li key={n} className="flex items-center gap-2.5">
              <span
                className={`flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-[10px] tabular-nums transition-colors ${
                  active
                    ? 'border-accent/60 bg-[var(--accent-soft)] text-accent'
                    : done
                      ? 'border-accent/40 text-accent'
                      : 'border-line text-text-3'
                }`}
              >
                {done ? '✓' : n}
              </span>
              <span
                className={`text-[12px] leading-snug transition-colors ${
                  active ? 'text-text-1' : done ? 'text-text-3' : 'text-text-2'
                }`}
              >
                {label}
              </span>
            </li>
          );
        })}
      </ol>

      <p className="text-[11px] leading-relaxed text-text-2">{GUIDE[mode].tip}</p>
    </div>
  );
}

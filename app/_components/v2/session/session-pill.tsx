'use client';

/**
 * SessionPill — a compact "instant trading is on" badge for the ticket chrome.
 * Shows only when a session is actually carrying trades (Slush + live key), with the
 * time left before it lapses. A flash glyph stands in for the word "Instant" and the
 * countdown shows a single largest unit (4h / 4m / 4s left), so the pill stays tight and
 * the ticket title beside it never truncates. Purely informational; the on/off control
 * lives in the nav wallet dropdown (WalletInstantTrading). See [[sessions-delegated-trading]].
 */
import { LuZap } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useNow } from '@/lib/hooks/use-now';

export function SessionPill() {
  const acct = usePredictAccountV2();
  // Seed 0 is the SSR-only snapshot; on the client useNow immediately switches to the
  // live clock. This component renders null server-side anyway (no wallet).
  const now = useNow(0);
  if (!acct.sessionActive || !acct.sessionExpiryMs) return null;
  // The session is "on", but if its gas has run below one trade's budget it can't
  // actually place instantly (trades fall back to a wallet pop-up). Show that honestly
  // so the pill never claims "no pop-up" when a pop-up is coming.
  const gasLow = !acct.sessionCanTrade;

  // Largest single unit only — "4h left" / "4m left" / "4s left" — instead of "4h 11m
  // left", so the badge stays narrow next to the title.
  const secs = Math.max(0, Math.floor((acct.sessionExpiryMs - now) / 1000));
  const left = secs >= 3600 ? `${Math.floor(secs / 3600)}h` : secs >= 60 ? `${Math.floor(secs / 60)}m` : `${secs}s`;

  return (
    <span
      className={`chip inline-flex h-5 shrink-0 items-center gap-1 whitespace-nowrap px-1.5 text-[9.5px] font-medium uppercase tracking-wider ${gasLow ? 'text-warn' : 'text-up'}`}
      title={
        gasLow
          ? 'Session gas is low, so trades ask for a wallet approval. Top it up to keep placing with no pop-up.'
          : 'Instant trading is on. Trades place with no wallet pop-up while it lasts.'
      }
    >
      <LuZap size={10} className="shrink-0" aria-hidden />
      {gasLow ? 'gas low' : `${left} left`}
    </span>
  );
}

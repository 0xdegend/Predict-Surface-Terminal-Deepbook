'use client';

/**
 * SessionPill — a compact "instant trading is on" badge for the ticket chrome.
 * Shows only when a session is actually carrying trades (Slush + live key), with
 * the time left before it lapses. Purely informational; the on/off control lives in
 * the nav wallet dropdown (WalletInstantTrading). See [[sessions-delegated-trading]].
 */
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useNow } from '@/lib/hooks/use-now';
import { countdown } from '@/lib/format';

export function SessionPill() {
  const acct = usePredictAccountV2();
  // Seed 0 is the SSR-only snapshot; on the client useNow immediately switches to
  // the live clock. This component renders null server-side anyway (no wallet).
  const now = useNow(0);
  if (!acct.sessionActive || !acct.sessionExpiryMs) return null;
  // The session is "on", but if its gas has run below one trade's budget it can't
  // actually place instantly (trades fall back to a wallet pop-up). Show that honestly
  // so the pill never claims "no pop-up" when a pop-up is coming.
  const gasLow = !acct.sessionCanTrade;
  return (
    <span
      className={`chip h-5 shrink-0 whitespace-nowrap px-1.5 text-[9.5px] font-medium uppercase tracking-wider ${gasLow ? 'text-warn' : 'text-up'}`}
      title={
        gasLow
          ? 'Session gas is low, so trades ask for a wallet approval — top it up to keep placing with no pop-up'
          : 'Trades place with no wallet pop-up while this is on'
      }
    >
      {gasLow ? 'Instant · gas low' : `Instant · ${countdown(acct.sessionExpiryMs, now)} left`}
    </span>
  );
}

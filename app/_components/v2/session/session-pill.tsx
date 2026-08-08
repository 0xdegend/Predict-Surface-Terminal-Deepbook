'use client';

/**
 * SessionPill — a compact "instant trading is on" badge for the ticket chrome.
 * Shows only when a session is actually carrying trades (Slush + live key), with
 * the time left before it lapses. Purely informational; the control lives in
 * SessionPanel. See [[sessions-delegated-trading]].
 */
import { LuZap } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useNow } from '@/lib/hooks/use-now';
import { countdown } from '@/lib/format';

export function SessionPill() {
  const acct = usePredictAccountV2();
  // Seed 0 is the SSR-only snapshot; on the client useNow immediately switches to
  // the live clock. This component renders null server-side anyway (no wallet).
  const now = useNow(0);
  if (!acct.sessionActive || !acct.sessionExpiryMs) return null;
  return (
    <span
      className="chip h-5 gap-1 px-1.5 text-[9.5px] font-medium uppercase tracking-wider text-up"
      title="Trades place with no wallet pop-up while this is on"
    >
      <LuZap size={10} className="shrink-0" />
      Instant · {countdown(acct.sessionExpiryMs, now)} left
    </span>
  );
}

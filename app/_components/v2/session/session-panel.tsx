'use client';

/**
 * SessionPanel — the compact status strip for a LIVE instant-trading session: what it
 * trades from, the optional one-tap mode, and End. Turning a session ON now happens
 * inside a trade (see InstantTradingToggle), so this renders ONLY while a session is
 * live and self-hides otherwise — no more form. See [[sessions-delegated-trading]].
 */
import { LuZap } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { useNow } from '@/lib/hooks/use-now';
import { GlassError } from '../../ui/glass-error';
import { Switch } from '../../ui/switch';
import { fromQuote } from '@/config/scale';
import { countdown } from '@/lib/format';
import { predictV2Config } from '@/config/predict';

export function SessionPanel() {
  const acct = usePredictAccountV2();
  const instantTrade = useSessionPrefs((s) => s.instantTrade);
  const setInstantTrade = useSessionPrefs((s) => s.setInstantTrade);
  // Seed 0 = SSR snapshot; the client switches to the live clock at once (null on server).
  const now = useNow(0);

  // Only while a session is actually carrying trades. Turn-on lives in the ticket now.
  // Shown for both wallet types: Slush loses the popup, Google gets faster submits.
  if (!acct.sessionsEnabled || !acct.sessionActive) return null;

  const sym = predictV2Config.quote.symbol;
  const busy = acct.busy === 'session';
  const budgetNow = fromQuote(acct.balanceBase);

  return (
    <div className="panel flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <span className="grid h-6 w-6 place-items-center rounded-md bg-(--accent-soft) text-up">
          <LuZap size={13} />
        </span>
        <h3 className="text-[13px] font-medium tracking-tight text-text-1">Instant trading</h3>
        {acct.sessionExpiryMs && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-up">
            <span className="h-1.5 w-1.5 rounded-full bg-up" /> On · {countdown(acct.sessionExpiryMs, now)} left
          </span>
        )}
      </div>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md">
        <div className="bg-white/2 px-3 py-2.5">
          <div className="eyebrow mb-0.5">Trades from</div>
          <div className="font-mono text-[15px] tabular-nums text-text-1">
            ${budgetNow.toLocaleString(undefined, { maximumFractionDigits: 2 })}{' '}
            <span className="text-[10px] text-text-3">{sym}</span>
          </div>
        </div>
        <div className="bg-white/2 px-3 py-2.5">
          {/* Slush's win is losing the popup; Google (already silent) gets faster submits. */}
          <div className="eyebrow mb-0.5">{acct.gasless ? 'Speed' : 'No pop-up'}</div>
          <div className="font-mono text-[15px] tabular-nums text-up">{acct.gasless ? 'Fast' : 'On'}</div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 rounded-lg bg-white/2 px-3 py-2.5">
        <span className="flex flex-col">
          <span className="text-[12px] text-text-1">One-tap trades</span>
          <span className="text-[10.5px] leading-snug text-text-3">Skip the review step too. Only for trades covered by your balance.</span>
        </span>
        <Switch checked={instantTrade} onChange={setInstantTrade} label="One-tap trades" />
      </div>

      <button
        onClick={() => acct.endSession()}
        disabled={busy}
        className="w-full rounded-lg border border-line py-2 text-[12px] font-medium text-text-2 transition-colors hover:border-white/20 hover:text-text-1 disabled:opacity-50"
      >
        {busy ? 'Ending session…' : 'End instant trading'}
      </button>

      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
    </div>
  );
}

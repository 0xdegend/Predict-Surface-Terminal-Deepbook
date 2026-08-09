'use client';

/**
 * WalletInstantTrading — the LIVE-session controls for instant trading, in the nav
 * wallet dropdown: the one-tap toggle and the End button (the old SessionPanel's two
 * controls, minus the bulky tiles). Turning instant trading ON — and the 24h/7d
 * choice — stays in the trade ticket (InstantTradingToggle), so this renders ONLY
 * while a session is live and self-hides otherwise. See [[sessions-delegated-trading]].
 */
import { LuZap } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { useNow } from '@/lib/hooks/use-now';
import { GlassError } from '../../ui/glass-error';
import { Switch } from '../../ui/switch';
import { countdown } from '@/lib/format';
import { SESSION_GAS_BUDGET } from '@/lib/sui/v2/session';

/** SUI held (base units) below which the session can't reliably cover another trade's
 *  gas — flag it so the user tops up before an instant trade fails to submit. */
const fmtSui = (base: bigint) => (Number(base) / 1e9).toLocaleString('en-US', { maximumFractionDigits: 3 });

export function WalletInstantTrading({ onTopUpGas }: { onTopUpGas?: () => void }) {
  const acct = usePredictAccountV2();
  const instantTrade = useSessionPrefs((s) => s.instantTrade);
  const setInstantTrade = useSessionPrefs((s) => s.setInstantTrade);
  // Seed 0 = SSR snapshot; the client switches to the live clock at once.
  const now = useNow(0);

  // Only while a session is actually carrying trades. Turn-on + duration live in the
  // ticket; this dropdown block is just gas, the one-tap toggle, and End.
  if (!acct.sessionsEnabled || !acct.sessionActive) return null;

  const busy = acct.busy === 'session';
  const gasLow = acct.sessionGasBase < SESSION_GAS_BUDGET;

  return (
    <div className="mt-0.5 flex flex-col gap-1.5 border-t border-line pt-2">
      <div className="flex items-center gap-2 px-1.5">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-(--accent-soft) text-up">
          <LuZap size={11} />
        </span>
        <span className="text-[12px] font-medium text-text-1">Instant trading</span>
        {acct.sessionExpiryMs && (
          <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-up">
            <span className="h-1.5 w-1.5 rounded-full bg-up" /> On · {countdown(acct.sessionExpiryMs, now ?? 0)} left
          </span>
        )}
      </div>

      {/* Session gas: the SUI the session key spends on each trade's network fee. When it
          runs low, instant trades stop submitting — so surface it with a top-up. */}
      <div className="glass-inset flex items-center justify-between gap-2 rounded-xl px-3 py-2.5">
        <span className="flex flex-col">
          <span className="text-[12px] text-text-1">Session gas</span>
          <span className="text-[10.5px] leading-snug text-text-3">
            <span className={gasLow ? 'text-warn' : 'text-text-2'}>{fmtSui(acct.sessionGasBase)} SUI</span> · pays the network fee
          </span>
        </span>
        <button
          onClick={onTopUpGas}
          className={`rounded-md px-2.5 py-1.5 text-[11px] font-medium transition-colors ${
            gasLow
              ? 'border border-warn/40 bg-(--warn-soft) text-warn hover:bg-warn/15'
              : 'ctrl-soft text-text-2 hover:text-text-1'
          }`}
        >
          Top up
        </button>
      </div>

      <div className="glass-inset flex items-center justify-between gap-2 rounded-xl px-3 py-2.5">
        <span className="flex flex-col">
          <span className="text-[12px] text-text-1">One-tap trades</span>
          <span className="text-[10.5px] leading-snug text-text-3">Skip the review step. Only for trades covered by your balance.</span>
        </span>
        <Switch checked={instantTrade} onChange={setInstantTrade} label="One-tap trades" />
      </div>

      <button
        onClick={() => acct.endSession()}
        disabled={busy}
        className="flex items-center justify-center rounded-xl border border-line px-3 py-2.5 text-[12px] font-medium text-text-2 transition-colors hover:border-white/20 hover:text-text-1 disabled:opacity-50"
      >
        {busy ? 'Ending…' : 'End instant trading'}
      </button>

      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
    </div>
  );
}

'use client';

/**
 * WalletInstantTrading — the LIVE-session controls for instant trading, in the nav
 * wallet dropdown. Turning instant trading ON — and the 24h/7d choice — lives in the
 * mint-confirm dialog (SessionOptInRow), so this renders ONLY while a session is live
 * and self-hides otherwise. See [[sessions-delegated-trading]].
 *
 * ONE FEATURE, ONE NAME. This block used to title itself "Instant trading" and then
 * offer a card called "One-tap trades" inside it, which reads as two features with two
 * switches. The section keeps the name; the setting inside it is now phrased as what it
 * does ("Skip the review step") so the hierarchy is obvious at a glance.
 *
 * The gas row only becomes a card when gas is actually LOW. While it's healthy there is
 * nothing for the trader to do about it, so it sits as one quiet line with a Top up link
 * instead of a third stacked tile.
 */
import { LuZap } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { useNow } from '@/lib/hooks/use-now';
import { GlassError } from '../../ui/glass-error';
import { Switch } from '../../ui/switch';
import { timeLeftWords } from '@/lib/format';
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
  // ticket; this dropdown block is just gas, the review-step toggle, and turning it off.
  if (!acct.sessionsEnabled || !acct.sessionActive) return null;

  const busy = acct.busy === 'session';
  const gasLow = acct.sessionGasBase < SESSION_GAS_BUDGET;
  // Coarse words ("23h", "6d"), not a ticking "23H 59M LEFT" in caps: this is a
  // day-long permission, so the minutes are noise and the caps read like an alarm.
  // Guarded on `now` because the SSR seed of 0 would date the countdown from 1970.
  const msLeft = acct.sessionExpiryMs && now ? acct.sessionExpiryMs - now : 0;

  return (
    <div className="mt-0.5 flex flex-col gap-1.5 border-t border-line pt-2">
      <div className="flex items-center gap-2 px-1.5">
        <span className="grid h-5 w-5 place-items-center rounded-md bg-(--accent-soft) text-up">
          <LuZap size={11} />
        </span>
        <span className="text-[12px] font-medium text-text-1">Instant trading</span>
        <span className="ml-auto inline-flex items-center gap-1.5 text-[10.5px] text-up">
          <span className="h-1.5 w-1.5 rounded-full bg-up" />
          {msLeft > 0 ? `On for ${timeLeftWords(msLeft)}` : 'On'}
        </span>
        {/* A small chip in the same control language as Top up, not the old full-width
            bordered button: it used to carry the same weight as Disconnect, so the menu
            ended in two heavy exits. Chip-sized, it still reads as pressable. */}
        <button
          onClick={() => acct.endSession()}
          disabled={busy}
          className="ctrl-soft shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-text-2 hover:text-text-1 disabled:opacity-50"
        >
          {busy ? 'Ending…' : 'Turn off'}
        </button>
      </div>

      {/* Session gas: the SUI the session key spends on each trade's network fee. When it
          runs low, instant trades stop submitting — so promote it to a card only then. */}
      {gasLow ? (
        <div className="glass-inset flex items-center justify-between gap-3 rounded-xl px-3 py-2.5">
          {/* min-w-0 so the copy is what wraps, never the button. */}
          <span className="flex min-w-0 flex-col">
            <span className="text-[12px] text-text-1">Fees running low</span>
            <span className="text-[10.5px] leading-snug text-text-3">
              <span className="text-warn">{fmtSui(acct.sessionGasBase)} SUI</span> left. Top up or instant
              trades stop going through.
            </span>
          </span>
          <button
            onClick={onTopUpGas}
            className="shrink-0 whitespace-nowrap rounded-md border border-warn/40 bg-(--warn-soft) px-2.5 py-1.5 text-[11px] font-medium text-warn transition-colors hover:bg-warn/15"
          >
            Top up
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 px-1.5">
          <span className="text-[10.5px] text-text-3">{fmtSui(acct.sessionGasBase)} SUI left for fees</span>
          {/* Same chip as Turn off, right-aligned so the two line up in a column. */}
          <button
            onClick={onTopUpGas}
            className="ctrl-soft ml-auto shrink-0 rounded-md px-2 py-1 text-[10px] font-medium text-text-2 hover:text-text-1"
          >
            Top up
          </button>
        </div>
      )}

      <div className="glass-inset flex items-center justify-between gap-2 rounded-xl px-3 py-2.5">
        <span className="flex flex-col">
          <span className="text-[12px] text-text-1">Skip the review step</span>
          <span className="text-[10.5px] leading-snug text-text-3">
            Trades your balance already covers place on one tap.
          </span>
        </span>
        <Switch checked={instantTrade} onChange={setInstantTrade} label="Skip the review step" />
      </div>

      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}
    </div>
  );
}

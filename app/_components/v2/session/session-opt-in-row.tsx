'use client';

/**
 * SessionOptInRow — the opt-in for delegated ("faster") trading, shown INSIDE the
 * mint-confirm dialog rather than in the trade ticket body. The ticket stays short;
 * this rides the review step every trade already passes through, so a first-time
 * trader still discovers it, and turning it on is one switch on the receipt they're
 * about to sign. When armed, the NEXT trade's approval also bundles `authorize_session`
 * — no separate transaction. Self-hides once a session is live (the nav wallet
 * dropdown's WalletInstantTrading takes over). See [[sessions-delegated-trading]].
 *
 * Returning users (a prior session that lapsed) get it pre-armed (opt-out), since they
 * already chose faster trades once; first-timers stay opt-in (off). Shows for BOTH
 * wallet types — a Slush wallet loses its per-trade pop-up, a Google wallet gets lower
 * latency (local signing, no sponsor round-trip). Google needs the treasury gas drip to
 * self-fund, so it's hidden for Google when that drip is off.
 */
import { useEffect, useRef } from 'react';
import { LuZap, LuInfo } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { sessionGasDrip } from '@/config/session-gas';
import { Switch } from '../../ui/switch';
import { DEFAULT_SESSION_GAS_FUNDING_BASE, type SessionDuration } from '@/lib/sui/v2/session';

const DURATIONS: { key: SessionDuration; label: string }[] = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
];

export function SessionOptInRow() {
  const acct = usePredictAccountV2();
  const armInstant = useSessionPrefs((s) => s.armInstant);
  const setArmInstant = useSessionPrefs((s) => s.setArmInstant);
  const sessionDuration = useSessionPrefs((s) => s.sessionDuration);
  const setSessionDuration = useSessionPrefs((s) => s.setSessionDuration);

  // Offered only where it helps and only before a session is live. A Google (gasless)
  // session can't self-fund gas without the treasury drip, so hide it for Google when
  // the drip is off.
  const gaslessBlocked = acct.gasless && !sessionGasDrip.enabled;
  const eligible =
    acct.sessionsEnabled && !!acct.owner && acct.wrapperExists && !acct.sessionActive && !gaslessBlocked;
  // A key that was authorized before and has now lapsed → a returning user.
  const expired = !!acct.sessionAddress && acct.sessionExpiryMs != null && !acct.sessionLive;

  // Returning user → pre-arm (opt-out): they already chose faster trades once, so
  // re-enabling should cost nothing. Seeded once per mount (the dialog remounts this
  // each time it opens), so flipping it off within a review sticks. First-timers keep
  // the store default (off) and opt in explicitly.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current || !eligible || !expired) return;
    seeded.current = true;
    if (!armInstant) setArmInstant(true);
  }, [eligible, expired, armInstant, setArmInstant]);

  if (!eligible) return null;

  const gasless = acct.gasless;
  const hasGas = acct.sessionGasBase >= DEFAULT_SESSION_GAS_FUNDING_BASE;
  const sub = gasless ? 'Your next trades skip the sign step.' : 'Your next trades skip the wallet pop-up.';
  // Fine print (only while armed): who pays the network fee and when it turns on.
  const gasNote =
    expired && hasGas
      ? 'Your session still has gas, so it turns on with this trade.'
      : sessionGasDrip.enabled
        ? 'We cover the network fee for you. It turns on with this trade.'
        : 'A little SUI for gas is added to this approval.';

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-line bg-white/2 p-3 font-sans">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2.5">
          <span
            className={`grid h-7 w-7 shrink-0 place-items-center rounded-md transition-colors ${
              armInstant ? 'bg-(--accent-soft) text-up' : 'bg-white/5 text-text-2'
            }`}
          >
            <LuZap size={13} />
          </span>
          <span className="flex flex-col">
            <span className="text-[12.5px] font-medium text-text-1">Faster trades</span>
            <span className="text-[10.5px] leading-snug text-text-3">{sub}</span>
          </span>
        </span>
        <Switch checked={armInstant} onChange={setArmInstant} label="Faster trades" />
      </div>

      {armInstant && (
        <div className="flex flex-col gap-2 border-t border-line pt-2.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[10px] font-medium uppercase tracking-wider text-text-3">Stays on for</span>
            {/* App's sliding glass segmented — a thumb glides between the two durations
                (full labels, so "7 days" never wraps). */}
            <div className="segmented w-40 text-[11px]" role="tablist" aria-label="Session length">
              <span
                aria-hidden
                className="segmented-thumb"
                style={{ transform: sessionDuration === '7d' ? 'translateX(100%)' : 'translateX(0)' }}
              />
              {DURATIONS.map((d) => (
                <button
                  key={d.key}
                  type="button"
                  role="tab"
                  aria-selected={sessionDuration === d.key}
                  onClick={() => setSessionDuration(d.key)}
                  className={`relative z-10 flex-1 rounded-lg py-1 text-center font-medium transition-colors ${
                    sessionDuration === d.key ? 'text-text-1' : 'text-text-3 hover:text-text-2'
                  }`}
                >
                  {d.label}
                </button>
              ))}
            </div>
          </div>
          <p className="flex items-start gap-1.5 text-[10px] leading-snug text-text-3">
            <LuInfo size={11} className="mt-px flex-none opacity-80" />
            <span>{gasNote}</span>
          </p>
        </div>
      )}
    </div>
  );
}

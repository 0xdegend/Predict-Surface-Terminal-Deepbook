'use client';

/**
 * InstantTradingToggle — the in-ticket way to turn on delegated trading, replacing
 * the old form panel. When armed, the NEXT trade also bundles `authorize_session`, so
 * one action sets up faster trading (the confirm modal discloses it). It self-hides
 * once a session is live (the pill/strip takes over) and re-appears after expiry with
 * "turn it back on" copy.
 *
 * Shows for BOTH wallet types, but the win differs: a Slush wallet loses its per-trade
 * pop-up; a Google wallet (already silent) gets LOWER LATENCY, since the session key
 * signs locally and skips the sponsor round-trips. A Google session needs the treasury
 * gas drip to self-fund, so the toggle only appears for Google when that drip is on.
 * See [[sessions-delegated-trading]].
 */
import { LuZap } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useSessionPrefs } from '@/lib/store/session-prefs-store';
import { sessionGasDrip } from '@/config/session-gas';
import { Switch } from '../../ui/switch';
import { DEFAULT_SESSION_GAS_FUNDING_BASE, type SessionDuration } from '@/lib/sui/v2/session';

const DURATIONS: { key: SessionDuration; label: string }[] = [
  { key: '24h', label: '24 hours' },
  { key: '7d', label: '7 days' },
];

export function InstantTradingToggle() {
  const acct = usePredictAccountV2();
  const armInstant = useSessionPrefs((s) => s.armInstant);
  const setArmInstant = useSessionPrefs((s) => s.setArmInstant);
  const sessionDuration = useSessionPrefs((s) => s.sessionDuration);
  const setSessionDuration = useSessionPrefs((s) => s.setSessionDuration);

  // Offered only where it helps and only before a session is live. A Google (gasless)
  // session can't self-fund gas without the treasury drip, so hide it for Google when
  // the drip is off. Once live, the status strip/pill takes over.
  const gaslessBlocked = acct.gasless && !sessionGasDrip.enabled;
  if (!acct.sessionsEnabled || !acct.owner || !acct.wrapperExists || acct.sessionActive || gaslessBlocked) {
    return null;
  }

  const gasless = acct.gasless;
  // A key that was authorized before and has now lapsed → "turn it back on" framing.
  const expired = !!acct.sessionAddress && acct.sessionExpiryMs != null && !acct.sessionLive;
  const hasGas = acct.sessionGasBase >= DEFAULT_SESSION_GAS_FUNDING_BASE;

  // Google already signs silently, so its win is speed; Slush's win is losing the popup.
  const title = expired
    ? gasless
      ? 'Turn faster trades back on'
      : 'Turn instant trading back on'
    : gasless
      ? 'Turn on faster trades'
      : 'Turn on instant trading';
  const subtitle = expired
    ? 'Your last session expired.'
    : gasless
      ? 'Approve once, then trades go straight through.'
      : 'Approve once, then no wallet pop-ups.';

  // Gas note. The treasury drip covers the fee for both wallet types when it is on; only
  // a Slush wallet with the drip off pays its own SUI.
  const gasNote =
    expired && hasGas
      ? 'Your session still has gas, so it is ready. It turns on with your next trade.'
      : sessionGasDrip.enabled
        ? 'We cover the network fee for you. It turns on with your next trade.'
        : 'A little SUI for gas is added to your next trade’s approval. It turns on with that trade.';

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-white/2 p-2.5">
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2">
          <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${armInstant ? 'bg-(--accent-soft) text-up' : 'bg-white/5 text-text-2'}`}>
            <LuZap size={12} />
          </span>
          <span className="flex flex-col">
            <span className="text-[12px] font-medium text-text-1">{title}</span>
            <span className="text-[10px] leading-snug text-text-3">{subtitle}</span>
          </span>
        </span>
        <Switch checked={armInstant} onChange={setArmInstant} label={title} />
      </div>

      {armInstant && (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            {DURATIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                onClick={() => setSessionDuration(d.key)}
                className={`rounded-md py-1.5 text-[11px] transition-colors ${
                  sessionDuration === d.key ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
                }`}
              >
                {d.label}
              </button>
            ))}
          </div>
          <span className="text-[10px] leading-relaxed text-text-3">{gasNote}</span>
        </>
      )}
    </div>
  );
}

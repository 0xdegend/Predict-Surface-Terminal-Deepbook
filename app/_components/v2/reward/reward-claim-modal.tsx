'use client';

/**
 * RewardClaimModal — the reduced-motion / no-WebGL fallback for the reward claim.
 *
 * A calm glass dialog that runs the exact same claim (via the orchestrator's
 * handlers) as the full-screen 3-D gift, for anyone who prefers reduced motion.
 * Presentational only — it takes the shared RewardClaimView. See
 * [[founding-traders-reward]].
 */
import { LuGift, LuArrowUpRight, LuCircleCheck, LuWallet } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';
import { REWARD_EXPLORER, REWARD_MOOD, type RewardClaimView } from './reward-shared';

const BTN_PRIMARY =
  'rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50';
const BTN_GHOST =
  'rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/[0.05] hover:text-text-1 disabled:opacity-50';

export function RewardClaimModal(v: RewardClaimView) {
  const { phase, amount, sym, busy } = v;

  const title =
    phase === 'done'
      ? `You received ${amount} ${sym}`
      : phase === 'error'
        ? 'Almost there'
        : 'A gift for you';
  const subtitle = phase === 'done' || phase === 'error' ? undefined : 'From the Skew team';

  const footer =
    phase === 'done' ? (
      <button onClick={v.onStartTrading} className={BTN_PRIMARY}>
        Start trading
      </button>
    ) : phase === 'error' ? (
      <>
        <button onClick={v.onClose} className={BTN_GHOST}>
          Close
        </button>
        <button onClick={v.onClaim} className={BTN_PRIMARY}>
          Try again
        </button>
      </>
    ) : (
      <>
        <button onClick={v.onClose} disabled={busy} className={BTN_GHOST}>
          Maybe later
        </button>
        <button onClick={v.onClaim} disabled={busy} className={BTN_PRIMARY}>
          {phase === 'paying'
            ? 'Sending your reward…'
            : phase === 'depositing'
              ? 'Adding to your account…'
              : `Claim ${amount} ${sym}`}
        </button>
      </>
    );

  return (
    <Modal
      open={v.open}
      onClose={v.onClose}
      title={title}
      subtitle={subtitle}
      variant="glass"
      mascot={REWARD_MOOD[phase]}
      footer={footer}
    >
      {phase === 'done' ? (
        <div className="flex flex-col gap-3">
          <div className="glass-inset flex items-center gap-3 px-4 py-3">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-[var(--accent-line)] bg-up/10 text-up">
              <LuCircleCheck size={17} />
            </span>
            <p className="text-[13px] leading-relaxed text-text-2">
              {v.inWalletOnly ? (
                <>
                  It’s in your wallet now and moves into your trading account automatically on your
                  first trade. Nothing else to do.
                </>
              ) : (
                <>
                  It’s in your trading account, ready to go. Pick a price on the surface and place a
                  trade.
                </>
              )}
            </p>
          </div>
          {v.paidDigest && (
            <a
              href={REWARD_EXPLORER(v.paidDigest)}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 self-start text-[11px] text-text-3 transition-colors hover:text-accent"
            >
              View on explorer
              <LuArrowUpRight size={12} />
            </a>
          )}
        </div>
      ) : phase === 'error' ? (
        <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-text-2">
          <p>{v.error ?? 'We couldn’t complete the claim just now.'}</p>
          <p className="text-[12px] text-text-3">
            Your reward is still waiting for you. Give it another try in a moment.
          </p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-3.5 py-1 text-center">
          <div className="flex items-center gap-2.5 rounded-xl border border-[var(--accent-line)] bg-[var(--accent-soft)] px-5 py-3">
            <LuGift size={18} className="text-up" />
            <span className="font-mono text-[26px] font-semibold tabular-nums text-up">{amount}</span>
            <span className="text-[13px] font-medium text-text-2">{sym}</span>
          </div>
          <p className="max-w-[36ch] text-[13px] leading-relaxed text-text-2">
            You’re one of Skew’s founding traders. As a thank you for being early, here’s {amount}{' '}
            {sym} to keep trading.
          </p>
          <p className="inline-flex items-center gap-1.5 text-[11px] text-text-3">
            <LuWallet size={12} />
            {busy ? 'Setting up your gift…' : 'Lands straight in your trading account'}
          </p>
        </div>
      )}
    </Modal>
  );
}

'use client';

/**
 * OnboardFundModal — one-tap first-run onboarding for the NEW deployment.
 *
 * A first-timer (connected wallet, no trading account yet) gets a single
 * "Fund & start" button that, back to back:
 *   1. drips a DUSDC starter grant to their wallet (plus a little gas SUI for
 *      external wallets — Google/Enoki is gasless), and
 *   2. creates their trading account,
 * so they land ready to trade. There's deliberately NO deposit step: the first
 * trade auto-deposits the wallet shortfall in the same transaction.
 *
 * These are two on-chain transactions (funding is treasury-signed, account
 * creation is user-signed, and create+deposit can't share one PTB because the new
 * account's id only exists after it's created), presented as a single click.
 * Google/Enoki signs both gaslessly (no popups); an external wallet approves the
 * create once.
 *
 * Self-contained — it runs its own account + grant hooks (deduped by query key,
 * like MobileFundBanner) and owns its open/dismiss state, so it's mounted once on
 * the trade screen and needs no props.
 */
import { useState } from 'react';
import { Modal } from '@/app/_components/ui/modal';
import { usePredictAccountV2, qkV2Account } from '@/lib/hooks/use-predict-account-v2';
import { useStarterGrant } from '@/lib/hooks/use-starter-grant';
import { useLegacyMove } from '@/lib/hooks/use-legacy-move';
import { starterGrant, STARTER_GRANT_BALANCE_CEILING } from '@/config/starter-grant';
import { predictV2Config } from '@/config/predict';
import { fromQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';
import type { MascotMood } from '@/lib/mascot';

type Phase = 'intro' | 'funding' | 'creating' | 'done' | 'error';

const MOOD: Record<Phase, MascotMood> = {
  intro: 'confident',
  funding: 'thinking',
  creating: 'thinking',
  done: 'won',
  error: 'loss',
};

const BTN_PRIMARY =
  'rounded-lg border border-[var(--accent-line)] bg-[var(--accent-soft)] px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50';
const BTN_GHOST =
  'rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/[0.05] hover:text-text-1 disabled:opacity-50';

export function OnboardFundModal() {
  const acct = usePredictAccountV2();
  const owner = acct.owner ?? null;
  const sym = predictV2Config.quote.symbol;
  const grant = useStarterGrant(owner, !acct.gasless, {
    invalidateKeys: owner ? [qkV2Account.walletDusdc(owner)] : [],
    symbol: sym,
  });
  // A returning trader after a redeploy is NOT a first-timer, even though they have no
  // account on this release. They have their own DUSDC sitting in an account on the old
  // one, and offering them a starter grant and a fresh empty account says nothing about
  // it — which reads as "your funds are gone". Same modal, different question.
  const legacy = useLegacyMove();
  const returning = legacy.hasFunds;

  const [phase, setPhase] = useState<Phase>('intro');
  const [errMsg, setErrMsg] = useState<string | null>(null);
  // The wallet this modal has been dismissed for (keyed by owner so a different
  // wallet is offered onboarding again). In-memory: a fresh mount re-offers it,
  // which is fine — the modal only ever shows for a wallet with no account yet.
  const [dismissedFor, setDismissedFor] = useState<string | null>(null);

  // First-timer = connected, the wrapper read SUCCEEDED, and it told us there is no trading
  // account. (A wallet WITH an account that's just low on DUSDC is a top-up, handled by the
  // ticket's own grant CTA, not this modal.)
  //
  // `wrapperKnown` is the load-bearing part. `readWrapper` throws on a transport failure, so
  // an errored query leaves `wrapperExists` false with `isLoading` already false — and the
  // old `!isLoading && !wrapperExists` test read a brief RPC failure as "never traded here".
  // A returning trader with a funded account was shown first-run onboarding offering to set
  // up an account they already had. Failing to CHECK is not the same as knowing.
  const firstTimer = !!owner && acct.wrapperKnown && !acct.wrapperExists;
  const busy = phase === 'funding' || phase === 'creating';

  // Derived, so there's no setState-in-effect: open for an un-dismissed first-timer,
  // and — once the flow has started — stay open through funding/creating/done/error
  // even as `wrapperExists` flips mid-create (which would otherwise close + flicker).
  // Wait for the old-release read before opening. The two variants say very different
  // things, so opening on the first-run copy and swapping it a moment later is worse than
  // a brief wait on a modal that only ever appears once.
  const open =
    !!owner && dismissedFor !== owner && !legacy.isLoading && (phase !== 'intro' || firstTimer);

  function dismiss() {
    if (busy) return; // don't let ESC/backdrop interrupt a signing tx
    setPhase('intro');
    setErrMsg(null);
    setDismissedFor(owner);
  }

  async function fundAndStart() {
    setErrMsg(null);

    // A returning trader takes the move instead: ONE transaction that creates the account
    // here and brings their old-release balance across. No starter grant — they are not
    // short of DUSDC, they are short of an account to hold it.
    if (returning) {
      setPhase('creating');
      const ok = await legacy.move();
      if (!ok) {
        setErrMsg(legacy.errMsg ?? `We couldn't move your ${sym} just now.`);
        setPhase('error');
        return;
      }
      setPhase('done');
      return;
    }

    const walletBase = acct.walletDusdcBase ?? 0n;
    const needsFunding = acct.balanceBase + walletBase < STARTER_GRANT_BALANCE_CEILING;

    // 1) Fund the wallet — only if actually short, and the treasury grant is enabled.
    if (needsFunding && starterGrant.enabled) {
      setPhase('funding');
      const { ok, code } = await grant.claim();
      // A hard failure (anything but "already funded") leaves the wallet unfunded,
      // so stop and offer the faucet. "already_funded" is fine — proceed to create.
      if (!ok && code !== 'already_funded') {
        setErrMsg(`We couldn't add ${sym} right now.`);
        setPhase('error');
        return;
      }
    }

    // 2) Create the trading account (gasless for Google, one wallet approval for others).
    if (!acct.wrapperExists) {
      setPhase('creating');
      let digest: string | null = null;
      try {
        digest = await acct.createAccount();
      } catch {
        digest = null;
      }
      if (!digest) {
        setErrMsg('Account setup was cancelled or didn’t go through.');
        setPhase('error');
        return;
      }
    }
    setPhase('done');
  }

  const grantLabel = `${fmtQuote(fromQuote(starterGrant.displayBase))} ${sym}`;
  // Whether the grant will actually be paid. `fundAndStart` skips it when the trader already
  // holds enough, so promising "2.00 DUSDC added to your wallet" to someone who is already
  // funded is a bullet that quietly does not happen. Undefined balances (still loading) are
  // treated as 0, which errs toward offering the grant rather than hiding it.
  const alreadyFunded =
    acct.balanceBase + (acct.walletDusdcBase ?? 0n) >= STARTER_GRANT_BALANCE_CEILING;
  const canFund = starterGrant.enabled && !alreadyFunded;

  const legacyAmount = `${fmtQuote(fromQuote(legacy.amount))} ${sym}`;
  const title =
    phase === 'done'
      ? 'You’re ready to trade'
      : phase === 'error'
        ? 'Almost there'
        : returning
          ? 'Predict moved to a new version'
          : 'Get set up to trade';
  const subtitle =
    phase === 'done'
      ? returning
        ? 'Your funds have moved across and your account is ready.'
        : 'Your account is funded and ready.'
      : phase === 'error'
        ? undefined
        : returning
          ? 'One transaction sets up your account here and brings your balance across.'
          : 'One tap sets up everything you need to place your first trade.';

  const footer =
    phase === 'done' ? (
      <button onClick={dismiss} className={BTN_PRIMARY}>
        Start trading
      </button>
    ) : phase === 'error' ? (
      <>
        <button onClick={dismiss} className={BTN_GHOST}>
          Close
        </button>
        <button onClick={fundAndStart} className={BTN_PRIMARY}>
          Try again
        </button>
      </>
    ) : (
      <>
        <button onClick={dismiss} disabled={busy} className={BTN_GHOST}>
          Maybe later
        </button>
        <button onClick={fundAndStart} disabled={busy} className={BTN_PRIMARY}>
          {phase === 'funding'
            ? `Adding ${sym}…`
            : phase === 'creating'
              ? returning
                ? 'Moving…'
                : 'Setting up…'
              : returning
                ? 'Set up account and move balance'
                : 'Fund & start'}
        </button>
      </>
    );

  return (
    <Modal open={open} onClose={dismiss} title={title} subtitle={subtitle} variant="glass" mascot={MOOD[phase]} footer={footer}>
      {phase === 'done' ? (
        <p className="text-[13px] leading-relaxed text-text-2">
          {returning ? (
            <>Your {sym} is in your new trading account. Pick a price on the surface and carry on.</>
          ) : (
            <>
              Pick a price on the surface and place your first trade. Your {sym} deposits
              automatically the moment you trade.
            </>
          )}
        </p>
      ) : phase === 'error' ? (
        <div className="flex flex-col gap-3 text-[13px] leading-relaxed text-text-2">
          <p>{errMsg}</p>
          {predictV2Config.faucetUrl && (
            <p className="text-[12px] text-text-3">
              You can also grab testnet {sym} from the{' '}
              <a href={predictV2Config.faucetUrl} target="_blank" rel="noreferrer" className="text-accent underline-offset-2 hover:underline">
                faucet
              </a>{' '}
              and try again.
            </p>
          )}
        </div>
      ) : (
        <ul className="flex flex-col gap-2.5 text-[13px] text-text-2">
          <li className="flex items-start gap-2.5">
            <Dot />
            <span>
              {returning ? (
                <>
                  Your <span className="text-text-1">{legacyAmount}</span> moved from your old
                  account
                </>
              ) : canFund ? (
                <>
                  <span className="text-text-1">{grantLabel}</span> added to your wallet to start
                  {!acct.gasless && <span className="text-text-3">, plus a little SUI for gas</span>}
                </>
              ) : (
                <>Get testnet {sym} to start (from the faucet)</>
              )}
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <Dot />
            <span>
              Your <span className="text-text-1">trading account</span>, created and ready
            </span>
          </li>
          <li className="flex items-start gap-2.5">
            <Dot />
            <span className="text-text-3">
              {acct.gasless
                ? 'No popups, no gas. You’re signed in with Google.'
                : returning
                  ? 'One quick wallet approval. It all happens in a single transaction.'
                  : 'One quick wallet approval to create your account'}
            </span>
          </li>
        </ul>
      )}
    </Modal>
  );
}

function Dot() {
  return <span aria-hidden className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-up/70" />;
}

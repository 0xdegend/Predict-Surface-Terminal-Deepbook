'use client';

/**
 * SessionGasModal — top up the delegated session key's SUI so instant trades keep paying
 * their own network fee once it runs low. A Slush owner funds it from their own SUI (an
 * owner-signed transfer to the session key). A Google (gasless) owner holds no SUI, so
 * the app treasury covers it via the /api/session-gas drip (subject to a short cooldown).
 * Mirrors the CashOutModal shape (form → animated success). See [[sessions-delegated-trading]].
 */
import { useState } from 'react';
import { LuArrowRight, LuCheck, LuExternalLink, LuTriangleAlert, LuZap } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { predictV2Config } from '@/config/predict';

const MIST = 1e9;
const mistToSui = (base: bigint) => Number(base) / MIST;
const suiToMist = (sui: number) => BigInt(Math.round(sui * MIST));
const fmtSui = (sui: number) => sui.toLocaleString('en-US', { maximumFractionDigits: 4 });

const PRESETS = [0.1, 0.25, 0.5]; // SUI quick-picks
/** Keep a little SUI in the wallet for the transfer's own gas when using Max. */
const GAS_RESERVE_MIST = 20_000_000n; // 0.02 SUI

type Step = 'form' | 'success';

function dripMessage(code?: string): string {
  switch (code) {
    case 'cooldown':
      return 'You topped up recently. Please try again in a few minutes.';
    case 'rate_limited':
      return 'The free top-up has hit its limit for now. Try again later.';
    case 'treasury_empty':
      return 'The free top-up is temporarily unavailable. Try again shortly.';
    case 'not_configured':
      return 'The free top-up is not available right now.';
    default:
      return 'Could not top up right now. Please try again.';
  }
}

export function SessionGasModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const acct = usePredictAccountV2();
  const gasless = acct.gasless;
  const sessionGas = mistToSui(acct.sessionGasBase);
  const walletSui = mistToSui(acct.walletSuiBase);

  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [result, setResult] = useState<{ addedSui: number; digest: string | null } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dripBusy, setDripBusy] = useState(false);

  // Reset each time the modal opens (render-time pattern, no effect).
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      setAmount('');
      setStep('form');
      setResult(null);
      setNotice(null);
    }
  }

  const busy = acct.busy === 'session-gas';
  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const amountBase = amountValid ? suiToMist(amountNum) : 0n;
  const maxBase = acct.walletSuiBase > GAS_RESERVE_MIST ? acct.walletSuiBase - GAS_RESERVE_MIST : 0n;
  const overBalance = amountBase > maxBase;
  const formValid = amountValid && !overBalance && maxBase > 0n;

  async function fundFromWallet() {
    if (!formValid || busy) return;
    setNotice(null);
    const digest = await acct.fundSessionGasFromWallet(amountBase);
    if (digest) {
      setResult({ addedSui: amountNum, digest });
      setStep('success');
    }
  }

  async function topUpFree() {
    if (dripBusy) return;
    setDripBusy(true);
    setNotice(null);
    try {
      const r = await acct.topUpSessionGasFree();
      if (r.ok && !r.alreadyFunded) {
        setResult({ addedSui: Number(r.suiAmount) / MIST, digest: r.digest ?? null });
        setStep('success');
      } else if (r.ok && r.alreadyFunded) {
        setNotice('Your session already has enough gas.');
      } else {
        setNotice(dripMessage(r.code));
      }
    } finally {
      setDripBusy(false);
    }
  }

  const titles: Record<Step, { title: string; subtitle?: string }> = {
    form: { title: 'Top up session gas', subtitle: 'Add SUI so instant trades keep paying the network fee' },
    success: { title: 'Session gas topped up' },
  };

  const footer =
    step === 'success' ? (
      <FooterPrimary onClick={onClose}>Done</FooterPrimary>
    ) : gasless ? (
      <>
        <FooterGhost onClick={onClose}>Cancel</FooterGhost>
        <FooterPrimary onClick={topUpFree} disabled={dripBusy}>
          {dripBusy ? 'topping up…' : 'Top up (free)'}
        </FooterPrimary>
      </>
    ) : (
      <>
        <FooterGhost onClick={onClose}>Cancel</FooterGhost>
        <FooterPrimary onClick={fundFromWallet} disabled={!formValid || busy}>
          {busy ? 'sending…' : 'Fund from wallet'} <LuArrowRight size={14} />
        </FooterPrimary>
      </>
    );

  return (
    <Modal open={open} onClose={onClose} variant="glass" title={titles[step].title} subtitle={titles[step].subtitle} footer={footer}>
      {step === 'form' && (
        <div className="flex flex-col gap-4">
          {/* current session gas */}
          <div className="glass-inset flex items-center justify-between p-4">
            <span className="flex items-center gap-2 text-[12px] text-text-2">
              <span className="grid h-6 w-6 place-items-center rounded-md bg-(--accent-soft) text-up">
                <LuZap size={12} />
              </span>
              Session gas now
            </span>
            <span className="font-mono text-[15px] tabular-nums text-text-1">
              {fmtSui(sessionGas)} <span className="text-[10px] text-text-3">SUI</span>
            </span>
          </div>

          {gasless ? (
            <p className="text-[12px] leading-relaxed text-text-3">
              Your session key pays the network fee on each instant trade. We cover it for you, so tap
              Top up to add more at no cost. If you just topped up, there is a short wait before the next
              one is allowed.
            </p>
          ) : (
            <>
              <p className="text-[12px] leading-relaxed text-text-3">
                Your session key pays the network fee on each instant trade. Send it a little SUI from
                your wallet so it can keep going.
              </p>

              <div className="grid grid-cols-3 gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setAmount(String(p))}
                    className={`rounded-md py-1.5 font-mono text-[11px] tabular-nums transition-colors ${
                      Number(amount) === p ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-2'
                    }`}
                  >
                    {p} SUI
                  </button>
                ))}
              </div>

              <label className="flex flex-col gap-1.5">
                <span className="eyebrow flex items-center justify-between">
                  <span>Amount</span>
                  <span className="normal-case text-text-3">Wallet: {fmtSui(walletSui)} SUI</span>
                </span>
                <div className="flex items-center gap-2">
                  <input
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    inputMode="decimal"
                    placeholder="0.00"
                    className="w-full rounded-lg border border-line bg-black/20 px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-text-1 outline-none transition-colors focus:border-(--accent-line)"
                  />
                  <span className="text-[11px] text-text-3">SUI</span>
                  <button
                    onClick={() => setAmount(String(Number(mistToSui(maxBase).toFixed(6))))}
                    className="rounded-md border border-line px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-2 transition-colors hover:border-(--accent-line) hover:text-accent"
                  >
                    Max
                  </button>
                </div>
                {overBalance && (
                  <span className="flex items-center gap-1 text-[11px] text-down">
                    <LuTriangleAlert size={11} /> More than your wallet SUI (minus a little kept for gas).
                  </span>
                )}
                {maxBase === 0n && (
                  <span className="text-[11px] text-warn">
                    Your wallet has no spare SUI. Add some SUI to this wallet first.
                  </span>
                )}
              </label>
            </>
          )}

          {notice && (
            <p className="rounded-lg border border-line bg-white/2 px-3 py-2 text-[11px] leading-relaxed text-text-2">
              {notice}
            </p>
          )}
          {acct.error && <p className="text-[11px] text-down">{acct.error}</p>}
        </div>
      )}

      {step === 'success' && result && (
        <SessionGasSuccess added={result.addedSui} digest={result.digest} />
      )}
    </Modal>
  );
}

/* ------------------------------ success ------------------------------ */

function SessionGasSuccess({ added, digest }: { added: number; digest: string | null }) {
  const explorer = digest ? `https://suiscan.xyz/${predictV2Config.network}/tx/${digest}` : null;
  return (
    <div className="flex flex-col items-center gap-5 py-3 text-center">
      <div className="relative flex h-16 w-16 items-center justify-center">
        <span
          aria-hidden
          className="absolute inset-0 rounded-full border border-up motion-safe:animate-[successRing_750ms_ease-out_forwards]"
        />
        <span className="flex h-16 w-16 items-center justify-center rounded-full bg-(--accent-soft) text-up shadow-[0_0_30px_-6px_var(--accent-glow)] motion-safe:animate-[checkPop_380ms_cubic-bezier(0.34,1.56,0.64,1)_both]">
          <LuCheck size={30} />
        </span>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="eyebrow">Added</span>
        <span className="flex items-baseline justify-center gap-1.5 font-mono tabular-nums">
          <span className="text-[34px] leading-none text-up">{fmtSui(added)}</span>
          <span className="text-[13px] text-text-3">SUI</span>
        </span>
        <span className="text-[12px] text-text-2">Instant trades can keep paying their own fee.</span>
      </div>
      {explorer && (
        <a
          href={explorer}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-[11px] text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline"
        >
          View on explorer <LuExternalLink size={11} />
        </a>
      )}
    </div>
  );
}

/* ------------------------------- bits -------------------------------- */

function FooterGhost({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/5 hover:text-text-1"
    >
      {children}
    </button>
  );
}

function FooterPrimary({ onClick, disabled, children }: { onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center gap-1.5 rounded-lg border border-(--accent-line) bg-(--accent-soft) px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
    >
      {children}
    </button>
  );
}

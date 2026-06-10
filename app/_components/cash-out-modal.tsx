'use client';

/**
 * CashOutModal — lets a zkLogin (Google) user move their DUSDC to an external
 * wallet they fully control. They can't export a key, so this is their exit:
 * one gasless transaction that drains the manager free balance + wallet DUSDC and
 * transfers it to a destination Sui address (see usePredictAccount.cashOut).
 *
 * Three steps: form → confirm → animated success. zkLogin has no wallet popup to
 * review the tx, so the confirm step is the safety gate, and the success step
 * counts the sent amount up as on-screen reassurance the funds went out.
 */
import { useEffect, useState } from 'react';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { LuArrowRight, LuArrowLeft, LuTriangleAlert, LuCheck, LuExternalLink } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote, shortId } from '@/lib/format';
import { predictConfig } from '@/config/predict';

type Step = 'form' | 'confirm' | 'success';

export function CashOutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const acct = usePredictAccount();
  const sym = predictConfig.quote.symbol;

  const walletBase = acct.dusdcBalance ?? 0n;
  const availableBase = acct.tradingBalanceBase + walletBase;
  const available = fromQuote(availableBase);

  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');
  const [step, setStep] = useState<Step>('form');
  const [sent, setSent] = useState<{ amount: number; digest: string } | null>(null);

  // Reset each time the modal opens (no effect — render-time pattern).
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      setDestination('');
      setAmount('');
      setStep('form');
      setSent(null);
    }
  }

  const dest = destination.trim();
  const destValid = isValidSuiAddress(dest);
  const destIsSelf = destValid && !!acct.owner && dest.toLowerCase() === acct.owner.toLowerCase();

  const amountNum = Number(amount);
  const amountValid = Number.isFinite(amountNum) && amountNum > 0;
  const amountBase = amountValid ? toQuote(amountNum) : 0n;
  const overBalance = amountBase > availableBase;

  const busy = acct.busy === 'cash-out';
  const formValid =
    destValid && !destIsSelf && amountValid && !overBalance && availableBase > 0n;

  async function confirmSend() {
    if (!formValid || busy) return;
    const digest = await acct.cashOut(dest, amountBase);
    if (digest) {
      setSent({ amount: amountNum, digest });
      setStep('success');
    }
  }

  const titles: Record<Step, { title: string; subtitle?: string }> = {
    form: { title: `Cash out ${sym}`, subtitle: 'Send to an external wallet you control' },
    confirm: { title: 'Confirm withdrawal', subtitle: 'Review before sending — this can’t be undone' },
    success: { title: 'Withdrawal sent' },
  };

  const footer =
    step === 'form' ? (
      <>
        <FooterGhost onClick={onClose}>Cancel</FooterGhost>
        <FooterPrimary onClick={() => setStep('confirm')} disabled={!formValid}>
          Review <LuArrowRight size={14} />
        </FooterPrimary>
      </>
    ) : step === 'confirm' ? (
      <>
        <FooterGhost onClick={() => setStep('form')}>
          <LuArrowLeft size={14} /> Back
        </FooterGhost>
        <FooterPrimary onClick={confirmSend} disabled={busy}>
          {busy ? 'sending…' : 'Confirm & send'}
        </FooterPrimary>
      </>
    ) : (
      <FooterPrimary onClick={onClose}>Done</FooterPrimary>
    );

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="glass"
      title={titles[step].title}
      subtitle={titles[step].subtitle}
      footer={footer}
    >
      {step === 'form' && (
        <div className="flex flex-col gap-4">
          <p className="text-[12px] leading-relaxed text-text-3">
            Your Google account is secured by your login — there’s no key to export. Move your {sym} to
            a wallet you fully control (a seed-phrase wallet). Gas is sponsored, so you don’t need any
            SUI. <span className="text-text-2">Transfers are irreversible.</span>
          </p>

          <div className="glass-inset flex flex-col gap-2 p-4 font-mono text-[12px] tabular-nums">
            <Row label="Winnings (free balance)" value={`${fmtQuote(fromQuote(acct.tradingBalanceBase))} ${sym}`} />
            <Row label="Wallet" value={`${fmtQuote(fromQuote(walletBase))} ${sym}`} />
            <div className="hairline-fade my-1" />
            <Row label="Available to send" value={`${fmtQuote(available)} ${sym}`} strong />
          </div>

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Destination address</span>
            <input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              placeholder="0x…"
              spellCheck={false}
              autoComplete="off"
              className="w-full rounded-lg border border-line bg-black/20 px-3 py-2.5 font-mono text-[12px] text-text-1 outline-none transition-colors focus:border-(--accent-line)"
            />
            {dest.length > 0 && !destValid && (
              <span className="text-[11px] text-down">Not a valid Sui address.</span>
            )}
            {destIsSelf && (
              <span className="text-[11px] text-warn">That’s this same account — use a different wallet.</span>
            )}
          </label>

          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Amount</span>
            <div className="flex items-center gap-2">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="w-full rounded-lg border border-line bg-black/20 px-3 py-2.5 text-right font-mono text-[13px] tabular-nums text-text-1 outline-none transition-colors focus:border-(--accent-line)"
              />
              <span className="text-[11px] text-text-3">{sym}</span>
              <button
                onClick={() => setAmount(String(Number(available.toFixed(6))))}
                className="rounded-md border border-line px-2.5 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-2 transition-colors hover:border-(--accent-line) hover:text-accent"
              >
                Max
              </button>
            </div>
            {overBalance && (
              <span className="flex items-center gap-1 text-[11px] text-down">
                <LuTriangleAlert size={11} /> Exceeds available balance.
              </span>
            )}
          </label>
        </div>
      )}

      {step === 'confirm' && (
        <div className="flex flex-col gap-4">
          <div className="glass-inset relative overflow-hidden p-4 text-center">
            <span className="eyebrow">You’re sending</span>
            <div className="mt-2 flex items-baseline justify-center gap-1.5 font-mono tabular-nums">
              <span className="text-[34px] leading-none text-up">{fmtQuote(amountNum)}</span>
              <span className="text-[13px] text-text-3">{sym}</span>
            </div>
          </div>

          <div className="glass-inset flex flex-col gap-2 p-4 font-mono text-[12px] tabular-nums">
            <Row label="To" value={shortId(dest, 10, 8)} strong />
            <Row label="Network" value={predictConfig.network} />
            <Row label="Gas" value="sponsored — free" />
          </div>

          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-warn">
            <LuTriangleAlert size={13} className="mt-0.5 flex-none" />
            Double-check the address. Sui transfers are irreversible — funds sent to the wrong address
            can’t be recovered.
          </p>
        </div>
      )}

      {step === 'success' && sent && (
        <CashOutSuccess amount={sent.amount} destination={dest} digest={sent.digest} sym={sym} />
      )}
    </Modal>
  );
}

/* ------------------------------ success ------------------------------ */

/** Animated success: a popping check + an expanding accent ring, and the sent
 *  amount counting up — the on-screen receipt for a gasless, popup-less tx. */
function CashOutSuccess({
  amount,
  destination,
  digest,
  sym,
}: {
  amount: number;
  destination: string;
  digest: string;
  sym: string;
}) {
  const shown = useCountUp(amount, 750);
  const explorer = `https://suiscan.xyz/${predictConfig.network}/tx/${digest}`;
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
        <span className="eyebrow">Sent</span>
        <span className="flex items-baseline justify-center gap-1.5 font-mono tabular-nums">
          <span className="text-[34px] leading-none text-up">{fmtQuote(shown)}</span>
          <span className="text-[13px] text-text-3">{sym}</span>
        </span>
        <span className="text-[12px] text-text-2">to {shortId(destination, 8, 6)}</span>
      </div>

      <a
        href={explorer}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-1.5 text-[11px] text-text-3 underline-offset-2 transition-colors hover:text-text-2 hover:underline"
      >
        View on explorer <LuExternalLink size={11} />
      </a>
    </div>
  );
}

/** Eases a number from 0 → target once (easeOutCubic). setState only fires inside
 *  the rAF callback, so this never cascades a synchronous render. */
function useCountUp(target: number, ms = 700): number {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / ms, 1);
      setV(target * (1 - Math.pow(1 - t, 3)));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return v;
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

function FooterPrimary({
  onClick,
  disabled,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
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

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-3">{label}</span>
      <span className={strong ? 'text-text-1' : 'text-text-2'}>{value}</span>
    </div>
  );
}

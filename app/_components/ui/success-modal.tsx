'use client';

/**
 * SuccessModal — a reusable, animated "it worked" confirmation for gasless,
 * popup-less flows where a bottom-right toast is easy to miss (starter-grant
 * funding, free-balance withdrawal, …). A popping check + expanding accent ring,
 * the amount counting up, an optional sub-line and explorer link, and a single
 * Done button. Presentation-only — the caller owns when to open it and the
 * formatted figures.
 *
 * Built on the shared Modal (glass), and the animated body lives in a child
 * component so its count-up only runs while the modal is actually open (Modal
 * renders nothing when closed → each open replays from 0).
 */
import { LuCheck, LuExternalLink } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';
import { useCountUp } from '@/lib/hooks/use-count-up';
import { quote as fmtQuote } from '@/lib/format';
import { predictConfig } from '@/config/predict';

export function SuccessModal({
  open,
  onClose,
  title,
  eyebrow,
  amount,
  sym = predictConfig.quote.symbol,
  sub,
  digest,
}: {
  open: boolean;
  onClose: () => void;
  /** Header line, e.g. "Account funded" / "Withdrawn to wallet". */
  title: string;
  /** Small label above the amount, e.g. "Received" / "Withdrawn". */
  eyebrow: string;
  /** DUSDC amount (human units) to count up. */
  amount: number;
  /** Currency symbol (defaults to the quote asset). */
  sym?: string;
  /** Optional line under the amount, e.g. "added to your wallet". */
  sub?: string;
  /** Optional executed tx digest → renders a "View on explorer" link. */
  digest?: string;
}) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      variant="glass"
      maxWidthClass="max-w-sm"
      footer={
        <button
          onClick={onClose}
          className="ctrl-soft rounded-lg px-4 py-2 text-[12px] font-semibold text-text-1"
        >
          Done
        </button>
      }
    >
      <SuccessBody eyebrow={eyebrow} amount={amount} sym={sym} sub={sub} digest={digest} />
    </Modal>
  );
}

function SuccessBody({
  eyebrow,
  amount,
  sym,
  sub,
  digest,
}: {
  eyebrow: string;
  amount: number;
  sym: string;
  sub?: string;
  digest?: string;
}) {
  const shown = useCountUp(amount, 750);
  const explorer = digest ? `https://suiscan.xyz/${predictConfig.network}/tx/${digest}` : null;
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
        <span className="eyebrow">{eyebrow}</span>
        <span className="flex items-baseline justify-center gap-1.5 font-mono tabular-nums">
          <span className="text-[34px] leading-none text-up">{fmtQuote(shown)}</span>
          <span className="text-[13px] text-text-3">{sym}</span>
        </span>
        {sub && <span className="text-[12px] text-text-2">{sub}</span>}
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

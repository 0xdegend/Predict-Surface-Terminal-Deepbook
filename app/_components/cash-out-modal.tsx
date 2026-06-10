'use client';

/**
 * CashOutModal — lets a zkLogin (Google) user move their DUSDC to an external
 * wallet they fully control. They can't export a key, so this is their exit:
 * one gasless transaction that drains the manager free balance + wallet DUSDC and
 * transfers it to a destination Sui address (see usePredictAccount.cashOut).
 */
import { useState } from 'react';
import { isValidSuiAddress } from '@mysten/sui/utils';
import { LuArrowRight, LuTriangleAlert } from 'react-icons/lu';
import { Modal } from '@/app/_components/ui/modal';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';
import { predictConfig } from '@/config/predict';

export function CashOutModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const acct = usePredictAccount();
  const sym = predictConfig.quote.symbol;

  const walletBase = acct.dusdcBalance ?? 0n;
  const availableBase = acct.tradingBalanceBase + walletBase;
  const available = fromQuote(availableBase);

  const [destination, setDestination] = useState('');
  const [amount, setAmount] = useState('');

  // Reset fields each time the modal opens (no effect — render-time pattern).
  const [seenOpen, setSeenOpen] = useState(open);
  if (open !== seenOpen) {
    setSeenOpen(open);
    if (open) {
      setDestination('');
      setAmount('');
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
  const canSend = destValid && !destIsSelf && amountValid && !overBalance && availableBase > 0n && !busy;

  async function send() {
    if (!canSend) return;
    const digest = await acct.cashOut(dest, amountBase);
    if (digest) onClose();
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      variant="glass"
      title={`Cash out ${sym}`}
      subtitle="Send to an external wallet you control"
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-lg px-3.5 py-2 text-[12px] text-text-2 transition-colors hover:bg-white/5 hover:text-text-1"
          >
            Cancel
          </button>
          <button
            onClick={send}
            disabled={!canSend}
            className="inline-flex items-center gap-1.5 rounded-lg border border-(--accent-line) bg-(--accent-soft) px-4 py-2 text-[12px] font-medium text-up transition-colors hover:bg-up/15 disabled:opacity-50"
          >
            {busy ? 'sending…' : 'Send'}
            {!busy && <LuArrowRight size={14} />}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-[12px] leading-relaxed text-text-3">
          Your Google account is secured by your login — there’s no key to export. Move your {sym} to
          a wallet you fully control (a seed-phrase wallet). Gas is sponsored, so you don’t need any
          SUI. <span className="text-text-2">Transfers are irreversible.</span>
        </p>

        {/* Available balances */}
        <div className="glass-inset flex flex-col gap-2 p-4 font-mono text-[12px] tabular-nums">
          <Row label="Winnings (free balance)" value={`${fmtQuote(fromQuote(acct.tradingBalanceBase))} ${sym}`} />
          <Row label="Wallet" value={`${fmtQuote(fromQuote(walletBase))} ${sym}`} />
          <div className="hairline-fade my-1" />
          <Row label="Available to send" value={`${fmtQuote(available)} ${sym}`} strong />
        </div>

        {/* Destination */}
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

        {/* Amount */}
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
    </Modal>
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

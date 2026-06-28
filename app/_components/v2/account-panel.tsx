'use client';

/**
 * V2AccountPanel — the trader's funds for the new deployment: account balance
 * (DUSDC) + custodied vault shares (PLP), with deposit (wallet → account) and
 * withdraw (account → wallet). Trading and vault flows draw from this balance.
 * Glass; plain copy; no orbs/borders.
 */
import { useState } from 'react';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { fromQuote, toQuote } from '@/config/scale';

type Mode = 'add' | 'withdraw';

export function V2AccountPanel() {
  const acct = usePredictAccountV2();
  const [mode, setMode] = useState<Mode>('add');
  const [amount, setAmount] = useState(25);

  const dusdc = fromQuote(acct.balanceBase);
  const plp = fromQuote(acct.plpBalanceBase);
  const busy = acct.busy === 'deposit' || acct.busy === 'withdraw';
  const overWithdraw = mode === 'withdraw' && toQuote(amount) > acct.balanceBase;

  async function submit() {
    if (mode === 'add') await acct.deposit(toQuote(amount));
    else await acct.withdraw(toQuote(amount));
  }

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <h3 className="text-[14px] font-medium tracking-tight text-text-1">Account</h3>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md">
        <Stat label="Available" value={`$${fmt(dusdc)}`} sub="DUSDC" />
        <Stat label="Vault shares" value={fmt(plp)} sub="PLP" />
      </div>

      {!acct.owner ? (
        <p className="text-[12px] text-text-3">Connect your wallet to fund your account.</p>
      ) : !acct.wrapperExists ? (
        <button
          onClick={() => acct.createAccount()}
          disabled={!!acct.busy}
          className="w-full rounded-lg bg-(--accent-soft) px-4 py-2.5 text-[13px] font-semibold text-up transition-colors disabled:opacity-50"
        >
          {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
        </button>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            <ModeBtn active={mode === 'add'} label="Add funds" onClick={() => setMode('add')} />
            <ModeBtn active={mode === 'withdraw'} label="Withdraw" onClick={() => setMode('withdraw')} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[12px] text-text-2">{mode === 'add' ? 'DUSDC to add' : 'DUSDC to withdraw'}</span>
            <div className="flex items-center gap-1">
              <span className="text-text-3">$</span>
              <input
                type="number"
                min={0}
                value={amount}
                onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
                className="w-24 rounded-md bg-white/5 px-2 py-1 text-right font-mono text-[13px] tabular-nums text-text-1 outline-none focus:bg-white/7"
              />
            </div>
          </div>
          <button
            onClick={submit}
            disabled={busy || amount <= 0 || overWithdraw}
            className="w-full rounded-lg bg-(--accent-soft) px-4 py-2.5 text-[13px] font-semibold text-up transition-colors disabled:opacity-50"
          >
            {busy ? 'Confirming…' : overWithdraw ? 'More than your balance' : mode === 'add' ? 'Add funds' : 'Withdraw to wallet'}
          </button>
        </>
      )}
      {acct.error && <p className="text-[11px] leading-relaxed text-down">{acct.error}</p>}
    </div>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="bg-white/2 px-3 py-2.5">
      <div className="eyebrow mb-0.5">{label}</div>
      <div className="font-mono text-[15px] tabular-nums text-text-1">
        {value} <span className="text-[10px] text-text-3">{sub}</span>
      </div>
    </div>
  );
}

function ModeBtn({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg py-2 text-[13px] font-medium transition-colors ${active ? 'bg-white/5 text-text-1' : 'text-text-2 hover:bg-white/3'}`}
    >
      {label}
    </button>
  );
}

function fmt(n: number): string {
  return n.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

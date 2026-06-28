'use client';

/**
 * V2VaultPanel — the ACTION side of the vault: queue a deposit (DUSDC → PLP) or a
 * withdrawal (PLP → DUSDC). Async by design — requests fill at the next vault
 * update (flush, NAV-priced), not instantly; shares/payout land in your account.
 * Read-side metrics live in V2VaultOverview. Glass; plain copy; no orbs/borders.
 */
import { useState } from 'react';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { fromQuote, toQuote } from '@/config/scale';

type Mode = 'add' | 'remove';

export function V2VaultPanel() {
  const acct = usePredictAccountV2();
  const [mode, setMode] = useState<Mode>('add');
  const [amount, setAmount] = useState(10);

  const plpBalance = fromQuote(acct.plpBalanceBase);
  const dusdcBalance = fromQuote(acct.balanceBase);

  async function submit() {
    if (mode === 'add') {
      const amt = toQuote(amount);
      const shortfall = amt > acct.balanceBase ? amt - acct.balanceBase : 0n;
      await acct.requestSupply(amt, shortfall > 0n ? shortfall : undefined);
    } else {
      await acct.requestWithdraw(toQuote(amount));
    }
  }

  const busy = acct.busy === 'supply' || acct.busy === 'withdraw-lp';
  const overWithdraw = mode === 'remove' && toQuote(amount) > acct.plpBalanceBase;

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <h3 className="text-[14px] font-medium tracking-tight text-text-1">Provide liquidity</h3>
      <p className="text-[11px] leading-relaxed text-text-2">
        Deposits and withdrawals join a queue and fill at the next vault update — not instantly.
      </p>

      <div className="grid grid-cols-2 gap-2">
        <ModeBtn active={mode === 'add'} label="Add" onClick={() => setMode('add')} />
        <ModeBtn active={mode === 'remove'} label="Remove" onClick={() => setMode('remove')} />
      </div>

      <div className="flex items-center justify-between">
        <span className="text-[12px] text-text-2">{mode === 'add' ? 'DUSDC to add' : 'Shares to remove'}</span>
        <input
          type="number"
          min={0}
          value={amount}
          onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
          className="w-28 rounded-md bg-white/5 px-2 py-1 text-right font-mono text-[13px] tabular-nums text-text-1 outline-none focus:bg-white/7"
        />
      </div>
      <div className="flex justify-between font-mono text-[10px] text-text-3">
        <span>{mode === 'add' ? `account: $${fmt(dusdcBalance)}` : `your shares: ${fmt(plpBalance)}`}</span>
        {mode === 'remove' && (
          <button className="text-text-2 hover:text-text-1" onClick={() => setAmount(plpBalance)}>
            max
          </button>
        )}
      </div>

      <VaultAction acct={acct} mode={mode} busy={busy} over={overWithdraw} onSubmit={submit} />
      {acct.error && <p className="text-[11px] leading-relaxed text-down">{acct.error}</p>}
    </div>
  );
}

function VaultAction({
  acct,
  mode,
  busy,
  over,
  onSubmit,
}: {
  acct: ReturnType<typeof usePredictAccountV2>;
  mode: Mode;
  busy: boolean;
  over: boolean;
  onSubmit: () => void;
}) {
  const base = 'w-full rounded-lg px-4 py-2.5 text-[13px] font-semibold tracking-tight transition-colors disabled:opacity-50';
  if (!acct.owner) return <button disabled className={`${base} bg-white/5 text-text-3`}>Connect your wallet</button>;
  if (!acct.wrapperExists)
    return (
      <button onClick={() => acct.createAccount()} disabled={!!acct.busy} className={`${base} bg-(--accent-soft) text-up`}>
        {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
      </button>
    );
  if (over) return <button disabled className={`${base} bg-white/5 text-text-3`}>More than your shares</button>;
  return (
    <button onClick={onSubmit} disabled={busy} className={`${base} bg-(--accent-soft) text-up`}>
      {busy ? 'Queuing…' : mode === 'add' ? 'Queue deposit' : 'Queue withdrawal'}
    </button>
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

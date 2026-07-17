'use client';

/**
 * V2VaultPanel — the ACTION side of the vault, in the legacy glass language:
 * segmented Add/Remove, a frosted amount field with quick picks + Max, and the
 * single glowing accent CTA. Async by design — requests queue and fill at the
 * next vault update (NAV-priced), not instantly; shares/payout land in the
 * trading account. Read-side metrics live in V2VaultOverview.
 */
import { useState } from 'react';
import type { IconType } from 'react-icons';
import { LuDroplets, LuUpload, LuDownload } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useLpQueue } from '@/lib/hooks/use-lp-queue';
import { fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { GlassError } from '../ui/glass-error';

type Mode = 'add' | 'remove';

const QUICK = [10, 25, 50];

export function V2VaultPanel() {
  const acct = usePredictAccountV2();
  const mounted = useMounted();
  const { mine } = useLpQueue(acct.accountId);
  const [mode, setMode] = useState<Mode>('add');
  const [amountStr, setAmountStr] = useState('10');

  const sym = predictV2Config.quote.symbol;
  const plpBalance = fromQuote(acct.plpBalanceBase);
  // A deposit that's still queued has NOT become PLP shares yet, so Remove — which
  // burns shares — has nothing to work with and reads as a dead end ("More than
  // your shares", with a shares balance of 0). Name the real state instead, and
  // point at the escape hatch (cancel), which is the only way out before a flush.
  const queuedDeposit = mine
    .filter((m) => m.side === 'supply')
    .reduce((s, m) => s + fromQuote(m.entry.amount), 0);
  const stuckOnQueue = mode === 'remove' && plpBalance <= 0 && queuedDeposit > 0;
  const accountBalance = fromQuote(acct.balanceBase);
  const walletBalance = acct.walletDusdcBase !== undefined ? fromQuote(acct.walletDusdcBase) : 0;

  const amount = parseFloat(amountStr) || 0;
  const busy = acct.busy === 'supply' || acct.busy === 'withdraw-lp';
  // Adding can top up from the wallet in the same transaction, so the ceiling
  // is account + wallet; removing is capped by the shares you hold.
  const addCeiling = accountBalance + walletBalance;
  const over = mode === 'add' ? amount > addCeiling + 1e-6 : amount > plpBalance + 1e-6;

  const reason = !mounted
    ? null
    : !acct.owner
      ? 'connect'
      : !acct.wrapperExists
        ? 'create'
        : amount <= 0
          ? 'enter'
          : over
            ? 'over'
            : 'ready';

  async function submit() {
    if (reason !== 'ready') return;
    if (mode === 'add') {
      const amt = toQuote(amount);
      // Short on account balance → top up the difference from the wallet in the same tx.
      const shortfall = amt > acct.balanceBase ? amt - acct.balanceBase : 0n;
      await acct.requestSupply(amt, shortfall > 0n ? shortfall : undefined);
    } else {
      await acct.requestWithdraw(toQuote(amount));
    }
    setAmountStr('10');
  }

  return (
    <div className="glass-card flex flex-col gap-4 p-4">
      {/* title */}
      <div className="flex items-center gap-2.5">
        <IconChip icon={LuDroplets} color={HUE.teal} size={26} />
        <div className="flex flex-col">
          <h3 className="text-[14px] font-semibold tracking-tight text-text-1">Provide liquidity</h3>
          <span className="text-[10px] text-text-3">queued · fills at the next vault update</span>
        </div>
      </div>

      {/* Add / Remove — the same segmented control as the portfolio tabs */}
      <div className="segmented w-full" role="tablist" aria-label="Vault action">
        <span
          aria-hidden
          className="segmented-thumb"
          style={{ transform: mode === 'remove' ? 'translateX(100%)' : 'translateX(0)' }}
        />
        <SegTab icon={LuUpload} label="Add" active={mode === 'add'} onClick={() => setMode('add')} />
        <SegTab icon={LuDownload} label="Remove" active={mode === 'remove'} onClick={() => setMode('remove')} />
      </div>

      {/* amount */}
      <label className="flex flex-col gap-1.5 font-mono tabular-nums">
        <span className="eyebrow">{mode === 'add' ? `${sym} to add` : 'Shares to remove'}</span>
        <div className="glass-inset flex items-center gap-2 px-3 py-2.5">
          <input
            inputMode="decimal"
            value={amountStr}
            onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ''))}
            className="w-full bg-transparent text-[16px] text-text-1 outline-none"
            placeholder="0.0"
          />
          <button
            onClick={() =>
              setAmountStr(String(Math.floor((mode === 'add' ? addCeiling : plpBalance) * 1e6) / 1e6))
            }
            className="ctrl-soft shrink-0 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider text-text-2"
          >
            Max
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK.map((v) => (
            <button
              key={v}
              onClick={() => setAmountStr(String(v))}
              className="glass-inset px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:text-text-1"
            >
              {v}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-text-3">
            {mode === 'add'
              ? `account ${fmtQuote(accountBalance)} · wallet ${fmtQuote(walletBalance)}`
              : `your shares ${fmtQuote(plpBalance)}`}
          </span>
        </div>
      </label>

      {stuckOnQueue && (
        <div className="glass-inset p-3">
          <p className="text-[11.5px] leading-relaxed text-text-2">
            <span className="font-medium text-text-1">
              Your {fmtQuote(queuedDeposit)} {sym} deposit is still in the queue.
            </span>{' '}
            It hasn&apos;t converted to PLP shares yet, and Remove can only sell shares — so
            there&apos;s nothing here to remove. To get it back now, cancel it in the queue below.
            Otherwise it fills at the next vault update.
          </p>
        </div>
      )}

      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}

      <ActionButton
        reason={reason}
        mode={mode}
        busy={busy}
        creating={acct.busy === 'create'}
        onSubmit={submit}
        onCreate={() => acct.createAccount()}
      />

      <p className="text-[10px] leading-relaxed text-text-3">
        {mode === 'add'
          ? `Your deposit joins the queue and converts to PLP shares at the next vault update, at the live share price. If your trading account is short, the difference tops up from your wallet in the same transaction.`
          : `Removing converts your shares back to ${sym} at the share price when the queue fills. That value rises and falls with the pool, so it isn't guaranteed.`}
      </p>
    </div>
  );
}

function SegTab({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: IconType;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={[
        'relative z-10 inline-flex flex-1 items-center justify-center gap-1.5 rounded-lg px-3.5 py-1.5 text-[11px] font-medium transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40',
        active ? 'text-text-1' : 'text-text-3 hover:text-text-2',
      ].join(' ')}
    >
      <Icon size={13} className={active ? 'text-accent' : ''} />
      {label}
    </button>
  );
}

function ActionButton({
  reason,
  mode,
  busy,
  creating,
  onSubmit,
  onCreate,
}: {
  reason: string | null;
  mode: Mode;
  busy: boolean;
  creating: boolean;
  onSubmit: () => void;
  onCreate: () => void;
}) {
  if (reason === null) {
    return <div className="h-11 animate-pulse rounded-lg bg-white/4" />;
  }
  if (reason === 'connect') {
    return (
      <button disabled className="h-11 rounded-lg border border-line text-[13px] font-semibold text-text-3 opacity-60">
        Connect your wallet
      </button>
    );
  }
  if (reason === 'create') {
    return (
      <button
        onClick={onCreate}
        disabled={creating}
        className="h-11 rounded-lg border border-(--accent-line) bg-(--accent-soft) text-[13px] font-semibold text-up shadow-[0_0_22px_-8px_var(--accent-glow)] transition-all hover:bg-up/15 disabled:opacity-60"
      >
        {creating ? 'Creating account…' : 'Create trading account'}
      </button>
    );
  }
  const ready = reason === 'ready';
  const label = !ready
    ? reason === 'enter'
      ? 'Enter an amount'
      : mode === 'add'
        ? 'More than your balance'
        : 'More than your shares'
    : busy
      ? 'Queuing…'
      : mode === 'add'
        ? 'Queue deposit'
        : 'Queue withdrawal';
  return (
    <button
      onClick={onSubmit}
      disabled={!ready || busy}
      className={`h-11 rounded-lg text-[13px] font-semibold transition-all ${
        ready
          ? 'border border-(--accent-line) bg-(--accent-soft) text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/15'
          : 'border border-line text-text-3'
      } disabled:opacity-60`}
    >
      {label}
    </button>
  );
}

'use client';

/**
 * Your vault position — track the PLP stake the Hedge Vault supplied on your
 * behalf, see its yield, and redeem it. PLP is a wallet coin (not a manager
 * position), so value is read straight from the wallet balance × the vault's
 * live share price. Yield = current value − net DUSDC deposited (from the /lp
 * flow history). Withdraw burns PLP for DUSDC via the verified predict::withdraw
 * entry, capped to the vault's withdrawal-limiter headroom.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { LuLandmark, LuTrendingUp, LuTrendingDown } from 'react-icons/lu';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { useMounted } from '@/lib/hooks/use-mounted';
import { getVaultSummary, getLpSupplies, getLpWithdrawals, qk } from '@/lib/api/client';
import { fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote, pct } from '@/lib/format';
import { predictConfig } from '@/config/predict';

export function VaultPositionPanel() {
  const acct = usePredictAccount();
  const mounted = useMounted();
  const owner = acct.owner;
  const [amountStr, setAmountStr] = useState('');

  const summaryQ = useQuery({
    queryKey: qk.vaultSummary,
    queryFn: () => getVaultSummary(),
    refetchInterval: 10_000,
  });
  const flowsQ = useQuery({
    queryKey: qk.lpFlows(owner ?? ''),
    queryFn: async () => {
      const [sup, wd] = await Promise.all([getLpSupplies(500), getLpWithdrawals(500)]);
      return { sup, wd };
    },
    enabled: !!owner,
    refetchInterval: 30_000,
  });

  const sym = predictConfig.quote.symbol;
  const plpBase = acct.plpBalance ?? 0n;
  const plpFloat = fromQuote(plpBase);
  const sharePrice = summaryQ.data?.plp_share_price ?? 0;
  const priced = sharePrice > 0;
  const currentValue = plpFloat * sharePrice;

  // Net DUSDC this wallet put in (supplied − withdrawn), the cost basis for yield.
  const netDeposited = useMemo(() => {
    if (!owner || !flowsQ.data) return 0;
    const lc = owner.toLowerCase();
    const supplied = flowsQ.data.sup
      .filter((s) => s.supplier?.toLowerCase() === lc)
      .reduce((a, s) => a + fromQuote(s.amount), 0);
    const withdrawn = flowsQ.data.wd
      .filter((w) => w.withdrawer?.toLowerCase() === lc)
      .reduce((a, w) => a + fromQuote(w.amount), 0);
    return supplied - withdrawn;
  }, [owner, flowsQ.data]);

  const yld = currentValue - netDeposited;
  const yldPct = netDeposited > 0 ? yld / netDeposited : 0;
  const showYield = priced && netDeposited > 0;

  const availableWithdrawal = fromQuote(summaryQ.data?.available_withdrawal ?? 0);
  const maxOut = Math.min(currentValue, availableWithdrawal);
  const limiterCaps = priced && availableWithdrawal < currentValue - 1e-6;

  const amount = parseFloat(amountStr) || 0;
  // Convert the desired DUSDC value to a PLP amount; if redeeming ~everything,
  // burn the full balance so no dust is left behind.
  const redeemAll = amount > 0 && amount >= currentValue - 1e-6;
  const plpToRedeem = redeemAll ? plpBase : priced ? toQuote(amount / sharePrice) : 0n;

  const hasPlp = plpBase > 0n;

  const reason = !mounted
    ? null
    : !owner
      ? 'connect'
      : !hasPlp
        ? 'empty'
        : amount <= 0
          ? 'enter'
          : amount > maxOut + 1e-6
            ? limiterCaps
              ? 'limiter'
              : 'exceeds'
            : plpToRedeem <= 0n
              ? 'enter'
              : 'ready';

  async function withdraw() {
    if (reason !== 'ready') return;
    await acct.withdrawPlp(plpToRedeem);
    setAmountStr('');
  }

  return (
    <div className="mx-auto w-full max-w-2xl px-4 pb-12 sm:px-5">
      <div className="mb-4 flex items-center gap-2">
        <LuLandmark size={16} className="text-[var(--accent)]" />
        <h2 className="text-[15px] font-semibold tracking-tight text-text-1">Your pool stake</h2>
      </div>

      {!mounted ? (
        <div className="glass-card h-44 animate-pulse" />
      ) : !owner ? (
        <div className="glass-card p-5 text-[12px] text-text-3">
          Connect a wallet to see your stake in the pool.
        </div>
      ) : !hasPlp ? (
        <div className="glass-card flex flex-col items-start gap-1 p-5">
          <span className="text-[13px] text-text-1">Nothing in the pool yet</span>
          <span className="text-[11px] leading-relaxed text-text-3">
            Add to the pool above to start earning a share of the trading fees — with or without crash
            protection. Your stake and earnings will show up here, and you can take your money out any
            time.
          </span>
        </div>
      ) : (
        <div className="glass-card flex flex-col gap-4 p-4 font-mono tabular-nums">
          {/* Headline value + yield */}
          <div className="flex items-end justify-between">
            <div className="flex flex-col gap-1">
              <span className="eyebrow">Current value</span>
              <span className="text-[26px] leading-none text-text-1">
                {priced ? fmtQuote(currentValue) : '…'}{' '}
                <span className="text-[12px] text-text-3">{sym}</span>
              </span>
            </div>
            {showYield && (
              <div className={`flex flex-col items-end gap-1 ${yld >= 0 ? 'text-up' : 'text-down'}`}>
                <span className="flex items-center gap-1 text-[13px]">
                  {yld >= 0 ? <LuTrendingUp size={13} /> : <LuTrendingDown size={13} />}
                  {yld >= 0 ? '+' : ''}
                  {fmtQuote(yld)} {sym}
                </span>
                <span className="text-[11px]">
                  {yld >= 0 ? '+' : ''}
                  {pct(yldPct, 2)}
                </span>
              </div>
            )}
          </div>

          {/* Stat grid */}
          <div className="grid grid-cols-2 gap-2.5">
            <Field label="Shares held" value={`${fmtQuote(plpFloat)} shares`} />
            <Field label="Net deposited" value={`${fmtQuote(netDeposited)} ${sym}`} />
            <Field label="Price per share" value={priced ? `${sharePrice.toFixed(4)} ${sym}` : '…'} />
            <Field label="Available now" value={`${fmtQuote(maxOut)} ${sym}`} />
          </div>

          {/* Withdraw */}
          <label className="flex flex-col gap-1.5">
            <span className="eyebrow">Withdraw ({sym})</span>
            <div className="glass-inset flex items-center gap-2 px-3 py-2.5">
              <input
                inputMode="decimal"
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value.replace(/[^0-9.]/g, ''))}
                className="w-full bg-transparent text-[16px] text-text-1 outline-none"
                placeholder="0.0"
              />
              <button
                onClick={() => setAmountStr(String(Math.floor(maxOut * 1e6) / 1e6))}
                className="ctrl-soft shrink-0 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider text-text-2"
              >
                Max
              </button>
            </div>
            {!redeemAll && amount > 0 && priced && (
              <span className="text-[10px] text-text-3">
                ≈ {fmtQuote(fromQuote(plpToRedeem))} shares cashed out
              </span>
            )}
            {limiterCaps && (
              <span className="font-sans text-[10px] leading-relaxed text-text-3">
                You can take out up to {fmtQuote(availableWithdrawal)} {sym} right now — some of the pool
                is backing open bets. The rest frees up as those finish.
              </span>
            )}
          </label>

          {acct.error && (
            <div className="rounded-lg border border-down/40 bg-down/10 p-2 text-[12px] text-down">
              {acct.error}
            </div>
          )}

          <WithdrawButton reason={reason} busy={acct.busy} onClick={withdraw} sym={sym} />

          <p className="font-sans text-[10px] leading-relaxed text-text-3">
            Taking money out converts your pool shares back to {sym} at the current price per share.
            That value rises and falls with the pool, so it isn&apos;t guaranteed. Any crash protection
            is a separate position on your Portfolio.
          </p>
        </div>
      )}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="glass-inset flex flex-col gap-1 p-3">
      <span className="eyebrow">{label}</span>
      <span className="text-[14px] leading-none text-text-1">{value}</span>
    </div>
  );
}

function WithdrawButton({
  reason,
  busy,
  onClick,
  sym,
}: {
  reason: string | null;
  busy: string | null;
  onClick: () => void;
  sym: string;
}) {
  if (reason === null) {
    return <div className="h-11 animate-pulse rounded-lg bg-white/[0.04]" />;
  }
  const label: Record<string, string> = {
    enter: 'Enter an amount',
    exceeds: 'More than your stake',
    limiter: 'More than you can take out now',
    ready: busy === 'withdraw-plp' ? 'withdrawing…' : `Withdraw ${sym}`,
  };
  const disabled = reason !== 'ready' || !!busy;
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`h-11 rounded-lg text-[13px] font-semibold transition-all ${
        reason === 'ready'
          ? 'border border-[var(--accent-line)] bg-[var(--accent-soft)] text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/15'
          : 'border border-line text-text-3'
      } disabled:opacity-60`}
    >
      {label[reason] ?? `Withdraw ${sym}`}
    </button>
  );
}

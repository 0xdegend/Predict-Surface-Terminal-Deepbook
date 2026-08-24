'use client';

/**
 * V2VaultHedge — crash protection for the Liquidity vault.
 *
 * A PLP provider is long the vault, so a sharp BTC drop is their worst day. This
 * card buys that risk down: a small budget mints a downside "crash" binary that
 * pays $1·qty if BTC settles below a strike a little under spot — a payout that
 * lands exactly when a crash would hurt the pool.
 *
 * Unlike legacy (an atomic supply+hedge via the predict_hedge router), v2's
 * deposit is ASYNC — it queues and fills at the keeper's flush — so a hedge
 * can't be fused into the same tx as a supply. Instead this is its own one-tap
 * action, which also lets existing LPs protect a position they already hold.
 * The strike is auto-picked (selectDownHedgeV2) on the longest-dated live
 * market; the mint uses the chain-sized budget path (mint_exact_amount), so the
 * cost is authoritative and the odds can't drift the bet under the $1 minimum.
 */
import { useMemo, useState } from 'react';
import type { IconType } from 'react-icons';
import { LuShieldCheck, LuTrendingDown, LuCoins, LuArrowDown } from 'react-icons/lu';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useNow } from '@/lib/hooks/use-now';
import { useV2Markets } from '@/lib/hooks/use-v2-markets';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { selectDownHedgeV2 } from '@/lib/hedge/select-v2';
import { binaryTicks, leverageScaled, maxCostWithSlippage } from '@/lib/sui/v2/ticks';
import { quantityForStake, minQuantityForBudget, mintAmountBase, MIN_STAKE_BASE } from '@/lib/sui/v2/quote';
import { fromQuote, toQuote, toFloat } from '@/config/scale';
import { quote as fmtQuote, price, pct, countdown } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { GlassError } from '../ui/glass-error';

const QUICK = [5, 10, 25];
// Skip markets about to settle — no runway for the protection to matter.
const MIN_RUNWAY_MS = 120_000;
const SLIPPAGE_BPS = 100; // 1% all-in cost headroom (deposit sizing), matches the trade ticket

export function V2VaultHedge() {
  const acct = usePredictAccountV2();
  const mounted = useMounted();
  // Seed 0 = SSR snapshot only; the shared live clock takes over on the client,
  // and the card body is gated on `mounted`, so the seed is never shown.
  const now = useNow(0);
  const sym = predictV2Config.quote.symbol;

  const [budgetStr, setBudgetStr] = useState('5');

  // Hedge on the longest-dated still-live market (most runway + variance), like
  // legacy. v2 markets roll every minute, so keep this list live.
  const markets = useV2Markets([]);
  const chosen = useMemo(() => {
    const live = markets
      .filter((m) => m.expiry > now + MIN_RUNWAY_MS)
      .sort((a, b) => b.expiry - a.expiry);
    return live[0] ?? null;
  }, [markets, now]);
  const { data: pricer } = useV2Pricer(chosen?.expiry_market_id ?? null);

  const hedge = useMemo(
    () =>
      chosen && pricer
        ? selectDownHedgeV2({
            forward: pricer.forward,
            svi: pricer.svi,
            admissionTickSize: BigInt(chosen.admission_tick_size),
          })
        : null,
    [chosen, pricer],
  );

  // Budget → chain-sized crash binary (mirror the trade ticket's budget path).
  const budget = parseFloat(budgetStr) || 0;
  const stakeBase = budget > 0 ? toQuote(budget) : 0n;
  const amount = mintAmountBase(stakeBase); // premium budget floor ($1.01 min)
  const entryProb = hedge?.fair ?? 0;
  const probOk = entryProb > 0.005 && entryProb < 0.995;
  const quantity = probOk ? quantityForStake(amount, entryProb, 1) : 0n; // max payout the budget buys
  const minQuantity = minQuantityForBudget(quantity);
  const feeBase = chosen ? BigInt(Math.round(toFloat(chosen.base_fee) * Number(quantity))) : 0n;
  const estCostBase = stakeBase + feeBase; // premium + fee (all-in estimate)
  const maxCost = maxCostWithSlippage(estCostBase, SLIPPAGE_BPS);

  const accountBase = acct.balanceBase;
  const walletBase = acct.walletDusdcBase ?? 0n;
  const ceilingBase = accountBase + walletBase; // budget path tops up from the wallet in-tx
  const shortfall = maxCost > accountBase ? maxCost - accountBase : 0n;

  // A crash hedge's fee rides the LARGE max-payout notional (a $5 premium buys
  // ~$125 of payout), so the all-in cost ≈ premium × (1 + fee/odds + slippage) —
  // meaningfully above the premium. Max sizes the PREMIUM so that all-in still
  // fits the balance (with a hair of headroom), instead of blowing past it.
  const loadFactor =
    probOk && chosen ? (1 + toFloat(chosen.base_fee) / entryProb) * (1 + SLIPPAGE_BPS / 10_000) : 1;
  const maxBudgetBase =
    loadFactor > 0 ? BigInt(Math.floor((Number(ceilingBase) * 0.995) / loadFactor)) : ceilingBase;

  const ticks = chosen && hedge ? binaryTicks(hedge.strikeScaled, false, BigInt(chosen.tick_size)) : null;

  const reason = !mounted
    ? null
    : !acct.owner
      ? 'connect'
      : !acct.wrapperExists
        ? 'create'
        : !chosen
          ? 'no-market'
          : !pricer
            ? 'pricing'
            : !hedge || !probOk
              ? 'unpriceable'
              : budget <= 0
                ? 'enter'
                : stakeBase < MIN_STAKE_BASE
                  ? 'too-small'
                  : maxCost > ceilingBase + 1n
                    ? 'insufficient'
                    : 'ready';

  async function buy() {
    if (reason !== 'ready' || !chosen || !ticks) return;
    const digest = await acct.mintBudget({
      marketId: chosen.expiry_market_id,
      lowerTick: ticks.lowerTick,
      higherTick: ticks.higherTick,
      amount,
      minQuantity,
      leverage: leverageScaled(1),
      deposit: shortfall > 0n ? shortfall : undefined,
    });
    if (digest) setBudgetStr('');
  }

  const walletDisplay = mounted ? fmtQuote(fromQuote(walletBase)) : '…';

  return (
    <div className="glass-card flex flex-col gap-4 p-4">
      {/* title */}
      <div className="flex items-center gap-2.5">
        <IconChip icon={LuShieldCheck} color={HUE.blue} size={26} />
        <div className="flex flex-col">
          <h3 className="text-[14px] font-semibold tracking-tight text-text-1">Crash protection</h3>
          <span className="text-[10px] text-text-3">optional · cushions your vault against a BTC drop</span>
        </div>
      </div>

      <p className="text-[11.5px] leading-relaxed text-text-3">
        Providing liquidity means you&apos;re long the pool, so a sharp BTC drop is your worst day.
        Spend a little to buy protection that pays out if that happens — softening the hit.
      </p>

      {/* budget */}
      <label className="flex flex-col gap-1.5 font-mono tabular-nums">
        <span className="eyebrow">Protection budget ({sym})</span>
        <div className="glass-inset flex items-center gap-2 px-3 py-2.5">
          <input
            inputMode="decimal"
            value={budgetStr}
            onChange={(e) => setBudgetStr(e.target.value.replace(/[^0-9.]/g, ''))}
            className="w-full bg-transparent text-[16px] text-text-1 outline-none"
            placeholder="0.0"
          />
          <button
            onClick={() => setBudgetStr(String(Math.floor(fromQuote(maxBudgetBase) * 1e6) / 1e6))}
            className="ctrl-soft shrink-0 rounded-md px-2 py-1 text-[10px] uppercase tracking-wider text-text-2"
          >
            Max
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {QUICK.map((v) => (
            <button
              key={v}
              onClick={() => setBudgetStr(String(v))}
              className="glass-inset px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:text-text-1"
            >
              {v}
            </button>
          ))}
          <span className="ml-auto text-[10px] text-text-3">
            account {mounted ? fmtQuote(fromQuote(accountBase)) : '…'} · wallet {walletDisplay}
          </span>
        </div>
      </label>

      {/* auto-selected hedge */}
      <div className="glass-inset flex items-center justify-between gap-3 p-3">
        <div className="flex items-center gap-2.5">
          <span className="dir-orb down scale-90" aria-hidden>
            <LuArrowDown size={18} />
          </span>
          <div className="flex flex-col">
            <span className="font-mono text-[13px] tabular-nums text-text-1">
              BTC ≤ {hedge ? price(hedge.strike, 0) : '—'}
            </span>
            <span className="text-[11px] text-text-3">
              {hedge ? `${pct(hedge.otmPct, 1)} below spot` : 'no live market'}
              {chosen ? ` · expires in ${countdown(chosen.expiry, now)}` : ''}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end">
          <span className="eyebrow">Cost each</span>
          <span className="font-mono text-[13px] tabular-nums text-text-1">
            {probOk ? pct(entryProb, 1) : '—'}
          </span>
        </div>
      </div>

      {/* preview */}
      <div className="grid grid-cols-2 gap-2.5">
        <Stat
          icon={LuCoins}
          color={HUE.amber}
          label="You pay"
          value={budget > 0 && probOk ? fmtQuote(fromQuote(estCostBase)) : '—'}
          unit={sym}
        />
        <Stat
          icon={LuTrendingDown}
          color={HUE.coral}
          label="Pays if it crashes"
          value={quantity > 0n ? fmtQuote(fromQuote(quantity)) : '—'}
          unit={sym}
        />
      </div>

      {hedge && quantity > 0n && (
        <p className="text-[11px] leading-relaxed text-text-3">
          If BTC finishes below {price(hedge.strike, 0)}, this pays {fmtQuote(fromQuote(quantity))} {sym} —
          offsetting the pool&apos;s loss. If it doesn&apos;t, the protection simply expires, and its cost was
          the price of insurance.
        </p>
      )}

      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}

      <ActionButton
        reason={reason}
        busy={acct.busy === 'mint'}
        creating={acct.busy === 'create'}
        onBuy={buy}
        onCreate={() => acct.createAccount()}
      />

      <p className="text-[10px] leading-relaxed text-text-3">
        You hold the protection directly as a position — it appears in your portfolio and redeems there.
        Bought on the longest-dated live market. {sym} · {predictV2Config.network}.
      </p>
    </div>
  );
}

function ActionButton({
  reason,
  busy,
  creating,
  onBuy,
  onCreate,
}: {
  reason: string | null;
  busy: boolean;
  creating: boolean;
  onBuy: () => void;
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
        {creating ? 'Creating account…' : 'Create trading account first'}
      </button>
    );
  }
  const ready = reason === 'ready';
  const label: Record<string, string> = {
    'no-market': 'No live market to protect against right now',
    pricing: 'Getting the price…',
    unpriceable: 'Can’t price protection right now. Try again shortly',
    enter: 'Enter an amount',
    'too-small': `Minimum protection is $1`,
    insufficient: 'Not enough DUSDC in your account or wallet',
    ready: busy ? 'Buying protection…' : 'Buy crash protection',
  };
  return (
    <button
      onClick={onBuy}
      disabled={!ready || busy}
      className={`h-11 rounded-lg text-[13px] font-semibold transition-all ${
        ready
          ? 'border border-(--accent-line) bg-(--accent-soft) text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/15'
          : 'border border-line text-text-3'
      } disabled:opacity-60`}
    >
      {label[reason] ?? 'Buy crash protection'}
    </button>
  );
}

function Stat({
  icon: Icon,
  color,
  label,
  value,
  unit,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  unit: string;
}) {
  return (
    <div className="glass-inset flex flex-col gap-1.5 p-3">
      <div className="flex items-center gap-2">
        <IconChip icon={Icon} color={color} size={20} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className="font-mono text-[16px] leading-none tabular-nums text-text-1">
        {value}
        <span className="ml-1 text-[10px] text-text-3">{unit}</span>
      </span>
    </div>
  );
}

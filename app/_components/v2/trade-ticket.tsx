'use client';

/**
 * V2TradeTicket — the trade ticket for the new deployment, in the right rail
 * (mirrors the legacy flow-panel feel). Reads the shared trade store (which market,
 * direction, strike, stake, leverage) and the live Pricer for the selected market,
 * then mints with a one-click signed tx (auto-depositing any shortfall).
 *
 * Stake-based "You pay": the trader picks a dollar stake; leverage multiplies the
 * max payout for the same stake. Cost is an estimate (no public cost view in v2) —
 * the wallet shows the exact figure and the on-chain max_cost guard caps it.
 * Plain copy; glass; no orbs/borders.
 */
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { upFair, dnFair, type SviFloat } from '@/lib/svi/svi';
import { fromFloat, toFloat, fromQuote, toQuote } from '@/config/scale';
import {
  snapStrikeToAdmission,
  binaryTicks,
  leverageScaled,
  maxProbabilityWithSlippage,
  maxCostWithSlippage,
} from '@/lib/sui/v2/ticks';
import { quantityForStake } from '@/lib/sui/v2/quote';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const SLIPPAGE_BPS = 100; // 1% cost-cap headroom

export function V2TradeTicket({ market, pricer }: { market: V2Market | null; pricer?: LivePricer }) {
  const acct = usePredictAccountV2();
  const isUp = useV2TradeStore((s) => s.isUp);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const strikeOffset = useV2TradeStore((s) => s.strikeOffset);
  const nudgeStrike = useV2TradeStore((s) => s.nudgeStrike);
  const stake = useV2TradeStore((s) => s.stake);
  const setStake = useV2TradeStore((s) => s.setStake);
  const leverage = useV2TradeStore((s) => s.leverage);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);

  if (!market) {
    return <div className="card px-4 py-6 text-[13px] text-text-3">Pick a market to trade.</div>;
  }
  if (!pricer) {
    return <div className="card px-4 py-6 text-[13px] text-text-3">Loading live price…</div>;
  }

  const svi: SviFloat = pricer.svi;
  const admStep = toFloat(market.admission_tick_size);
  const atm = toFloat(snapStrikeToAdmission(fromFloat(pricer.forward), BigInt(market.admission_tick_size)));
  const strike = atm + strikeOffset * admStep;
  const entryProb = isUp ? upFair(strike, pricer.forward, svi) : dnFair(strike, pricer.forward, svi);

  const stakeBase = toQuote(stake);
  const quantity = quantityForStake(stakeBase, entryProb, leverage); // max payout base units
  const feeBase = BigInt(Math.round(toFloat(market.base_fee) * Number(quantity)));
  const estCostBase = stakeBase + feeBase;
  const maxCost = maxCostWithSlippage(estCostBase, SLIPPAGE_BPS);

  const snapped = snapStrikeToAdmission(fromFloat(strike), BigInt(market.admission_tick_size));
  const { lowerTick, higherTick } = binaryTicks(snapped, isUp, BigInt(market.tick_size));
  const maxProbability = maxProbabilityWithSlippage(fromFloat(entryProb), SLIPPAGE_BPS, BigInt(market.max_entry_probability));

  const quotable = entryProb > 0.01 && entryProb < 0.99 && stake > 0;
  const shortfall = maxCost > acct.balanceBase ? maxCost - acct.balanceBase : 0n;
  const maxLev = Math.max(1, Math.floor(toFloat(market.max_admission_leverage)));

  async function mint() {
    await acct.mint({
      marketId: market!.expiry_market_id,
      lowerTick,
      higherTick,
      quantity,
      leverage: leverageScaled(leverage),
      maxCost,
      maxProbability,
      deposit: shortfall > 0n ? shortfall : undefined,
    });
  }

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-medium tracking-tight text-text-1">Trade</h3>
        <span className="font-mono text-[11px] text-text-3">${pricer.forward.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      </div>

      {/* direction */}
      <div className="grid grid-cols-2 gap-2">
        <DirBtn active={isUp} tone="up" label="Up" sub={`${(upFair(strike, pricer.forward, svi) * 100).toFixed(1)}%`} onClick={() => setIsUp(true)} />
        <DirBtn active={!isUp} tone="down" label="Down" sub={`${(dnFair(strike, pricer.forward, svi) * 100).toFixed(1)}%`} onClick={() => setIsUp(false)} />
      </div>

      {/* strike */}
      <Row label={`Strike ${isUp ? '(settles above)' : '(settles at/below)'}`}>
        <div className="flex items-center gap-1">
          <StepBtn onClick={() => nudgeStrike(-1)}>−</StepBtn>
          <span className="min-w-20 text-center font-mono text-[13px] tabular-nums text-text-1">
            ${strike.toLocaleString(undefined, { maximumFractionDigits: 0 })}
          </span>
          <StepBtn onClick={() => nudgeStrike(1)}>+</StepBtn>
        </div>
      </Row>

      {/* stake — "you pay" */}
      <Row label="You pay">
        <div className="flex items-center gap-1">
          <span className="text-text-3">$</span>
          <input
            type="number"
            min={0}
            value={stake}
            onChange={(e) => setStake(Number(e.target.value) || 0)}
            className="w-24 rounded-md bg-white/5 px-2 py-1 text-right font-mono text-[13px] tabular-nums text-text-1 outline-none focus:bg-white/7"
          />
        </div>
      </Row>

      {/* leverage */}
      <div>
        <Row label={`Leverage · ${leverage}x`}>
          <span className="font-mono text-[11px] text-text-3">up to {maxLev}x</span>
        </Row>
        <input
          type="range"
          min={1}
          max={maxLev}
          step={1}
          value={Math.min(leverage, maxLev)}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="mt-1 w-full accent-accent"
        />
        {leverage > 1 && (
          <p className="mt-1 text-[11px] leading-relaxed text-text-3">
            {leverage}× the payout for the same stake — but the position is closed early if the
            price moves far enough against you.
          </p>
        )}
      </div>

      {/* summary */}
      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-3 font-mono text-[12px] tabular-nums">
        <SumRow label="Entry odds" value={`${(entryProb * 100).toFixed(2)}%`} />
        <SumRow label="Max payout" value={`$${fromQuote(quantity).toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <SumRow label="Cost cap" value={`$${fromQuote(maxCost).toFixed(2)}`} muted />
      </div>

      <ActionButton acct={acct} quotable={quotable} onMint={mint} shortfall={shortfall} />
      {acct.error && <p className="text-[11px] leading-relaxed text-down">{acct.error}</p>}
      <p className="text-[10px] leading-relaxed text-text-3">
        Cost is an estimate; your wallet shows the exact amount before you approve.
      </p>
    </div>
  );
}

function ActionButton({
  acct,
  quotable,
  onMint,
  shortfall,
}: {
  acct: ReturnType<typeof usePredictAccountV2>;
  quotable: boolean;
  onMint: () => void;
  shortfall: bigint;
}) {
  const base = 'w-full rounded-lg px-4 py-2.5 text-[13px] font-semibold tracking-tight transition-colors disabled:opacity-50';
  if (!acct.owner) return <button disabled className={`${base} bg-white/5 text-text-3`}>Connect your wallet to trade</button>;
  if (!acct.wrapperExists)
    return (
      <button onClick={() => acct.createAccount()} disabled={!!acct.busy} className={`${base} bg-(--accent-soft) text-up`}>
        {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
      </button>
    );
  if (!quotable) return <button disabled className={`${base} bg-white/5 text-text-3`}>Strike too far from price to quote</button>;
  return (
    <button onClick={onMint} disabled={!!acct.busy} className={`${base} bg-(--accent-soft) text-up`}>
      {acct.busy === 'mint' || acct.busy === 'deposit' ? 'Confirming…' : shortfall > 0n ? 'Deposit & mint' : 'Mint position'}
    </button>
  );
}

function DirBtn({ active, tone, label, sub, onClick }: { active: boolean; tone: 'up' | 'down'; label: string; sub: string; onClick: () => void }) {
  const color = tone === 'up' ? 'text-up' : 'text-down';
  return (
    <button onClick={onClick} className={`flex flex-col items-center rounded-lg py-2 transition-colors ${active ? 'bg-white/5' : 'hover:bg-white/3'}`}>
      <span className={`text-[13px] font-semibold ${active ? color : 'text-text-2'}`}>{label}</span>
      <span className="font-mono text-[11px] text-text-3">{sub}</span>
    </button>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-[12px] text-text-2">{label}</span>
      {children}
    </div>
  );
}

function StepBtn({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button onClick={onClick} className="h-6 w-6 rounded-md bg-white/5 font-mono text-[13px] text-text-2 transition-colors hover:bg-white/8 hover:text-text-1">
      {children}
    </button>
  );
}

function SumRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-text-3' : 'text-text-2'}>{label}</span>
      <span className={muted ? 'text-text-3' : 'text-text-1'}>{value}</span>
    </div>
  );
}

'use client';

/**
 * V2TradeTicket — the new-deployment trade ticket (Phase 2).
 *
 * Read-only inputs + a one-click signed mint against the v2 account model
 * (AccountWrapper / Auth / leverage). Fair odds are computed client-side off the
 * live Pricer snapshot passed from the server; cost is an estimate (the wallet
 * shows the exact figure at signing — there's no public cost view in v2). Copy is
 * deliberately plain: "up to Nx", "closed early if price moves against you".
 *
 * Funding is folded in: if the account balance can't cover the estimated cost,
 * the shortfall is deposited in the same transaction as the mint.
 */
import { useState } from 'react';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useNow } from '@/lib/hooks/use-now';
import { upFair, dnFair, type SviFloat } from '@/lib/svi/svi';
import { fromFloat, toFloat, fromQuote } from '@/config/scale';
import {
  snapStrikeToAdmission,
  binaryTicks,
  leverageScaled,
  maxProbabilityWithSlippage,
} from '@/lib/sui/v2/ticks';
import { estimateMint, quantityForPayout } from '@/lib/sui/v2/quote';

export interface V2TicketMarket {
  marketId: string;
  cadenceLabel: string;
  expiry: number;
  forward: number;
  svi: SviFloat;
  tickSize: string;
  admissionTickSize: string;
  maxEntryProbability: string;
  maxLeverage: number;
  baseFee: string;
}

const SLIPPAGE_BPS = 100; // 1% default cost-cap headroom

export function V2TradeTicket({ markets, seedNow }: { markets: V2TicketMarket[]; seedNow: number }) {
  const acct = usePredictAccountV2();
  const now = useNow(seedNow);
  const [selectedId, setSelectedId] = useState(markets[0]?.marketId ?? '');
  const [isUp, setIsUp] = useState(true);
  const [strikeOffset, setStrikeOffset] = useState(0); // in $1 admission steps from ATM
  const [payout, setPayout] = useState(10); // max payout in DUSDC
  const [leverage, setLeverage] = useState(1);

  const market = markets.find((m) => m.marketId === selectedId) ?? markets[0];

  if (!market) {
    return (
      <div className="card px-4 py-6 text-[13px] text-text-3">
        No live markets to trade right now — check back in a moment.
      </div>
    );
  }

  const admStep = toFloat(market.admissionTickSize); // $1
  const atm = toFloat(snapStrikeToAdmission(fromFloat(market.forward), BigInt(market.admissionTickSize)));
  const strike = atm + strikeOffset * admStep;
  const entryProb = isUp ? upFair(strike, market.forward, market.svi) : dnFair(strike, market.forward, market.svi);

  const quantity = quantityForPayout(payout);
  const est = estimateMint({ entryProb, quantityBase: quantity, baseFee1e9: market.baseFee, slippageBps: SLIPPAGE_BPS });

  const snapped = snapStrikeToAdmission(fromFloat(strike), BigInt(market.admissionTickSize));
  const { lowerTick, higherTick } = binaryTicks(snapped, isUp, BigInt(market.tickSize));
  const maxProbability = maxProbabilityWithSlippage(
    fromFloat(entryProb),
    SLIPPAGE_BPS,
    BigInt(market.maxEntryProbability),
  );

  const quotable = entryProb > 0.01 && entryProb < 0.99;
  const shortfall = est.maxCostBase > acct.balanceBase ? est.maxCostBase - acct.balanceBase : 0n;

  async function mint() {
    await acct.mint({
      marketId: market.marketId,
      lowerTick,
      higherTick,
      quantity,
      leverage: leverageScaled(leverage),
      maxCost: est.maxCostBase,
      maxProbability,
      deposit: shortfall > 0n ? shortfall : undefined,
    });
  }

  const countdown = Math.max(0, Math.round((market.expiry - now) / 1000));

  return (
    <div className="panel flex flex-col gap-4 p-4">
      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-medium tracking-tight text-text-1">Trade · Latest</h3>
        <span className="font-mono text-[11px] text-text-3">{market.cadenceLabel}</span>
      </div>

      {/* market selector */}
      <div className="flex flex-wrap gap-1.5">
        {markets.map((m) => (
          <button
            key={m.marketId}
            onClick={() => setSelectedId(m.marketId)}
            className={`rounded-md px-2.5 py-1 font-mono text-[11px] transition-colors ${
              m.marketId === market.marketId ? 'bg-(--accent-soft) text-text-1' : 'text-text-2 hover:text-text-1'
            }`}
          >
            {m.cadenceLabel}
          </button>
        ))}
      </div>

      {/* direction */}
      <div className="grid grid-cols-2 gap-2">
        <DirBtn active={isUp} tone="up" label="Up" sub={`${(upFair(strike, market.forward, market.svi) * 100).toFixed(1)}%`} onClick={() => setIsUp(true)} />
        <DirBtn active={!isUp} tone="down" label="Down" sub={`${(dnFair(strike, market.forward, market.svi) * 100).toFixed(1)}%`} onClick={() => setIsUp(false)} />
      </div>

      {/* strike */}
      <Row label={`Strike ${isUp ? '(settles above)' : '(settles at/below)'}`}>
        <Stepper
          value={`$${strike.toLocaleString(undefined, { maximumFractionDigits: 0 })}`}
          onDec={() => setStrikeOffset((o) => o - 1)}
          onInc={() => setStrikeOffset((o) => o + 1)}
        />
      </Row>

      {/* max payout */}
      <Row label="Max payout">
        <input
          type="number"
          min={1}
          value={payout}
          onChange={(e) => setPayout(Math.max(1, Number(e.target.value) || 0))}
          className="w-24 rounded-md bg-white/5 px-2 py-1 text-right font-mono text-[13px] tabular-nums text-text-1 outline-none focus:bg-white/7"
        />
      </Row>

      {/* leverage */}
      <div>
        <Row label={`Leverage · ${leverage}x`}>
          <span className="font-mono text-[11px] text-text-3">up to {market.maxLeverage}x</span>
        </Row>
        <input
          type="range"
          min={1}
          max={Math.max(1, Math.floor(market.maxLeverage))}
          step={1}
          value={leverage}
          onChange={(e) => setLeverage(Number(e.target.value))}
          className="mt-1 w-full accent-accent"
        />
        {leverage > 1 && (
          <p className="mt-1 text-[11px] leading-relaxed text-text-3">
            {leverage}× control for a smaller upfront cost — but the position is closed early if the
            price moves far enough against you.
          </p>
        )}
      </div>

      {/* summary */}
      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-3 font-mono text-[12px] tabular-nums">
        <SumRow label="Entry odds" value={`${(entryProb * 100).toFixed(2)}%`} />
        <SumRow label="Max payout" value={`$${payout.toFixed(2)}`} />
        <SumRow label="Est. cost" value={`~$${fromQuote(est.estCostBase).toFixed(2)}`} />
        <SumRow label="Cost cap" value={`$${fromQuote(est.maxCostBase).toFixed(2)}`} muted />
      </div>

      {/* action */}
      <ActionButton
        acct={acct}
        quotable={quotable}
        countdown={countdown}
        onMint={mint}
        shortfall={shortfall}
      />
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
  countdown,
  onMint,
  shortfall,
}: {
  acct: ReturnType<typeof usePredictAccountV2>;
  quotable: boolean;
  countdown: number;
  onMint: () => void;
  shortfall: bigint;
}) {
  const base = 'w-full rounded-lg px-4 py-2.5 text-[13px] font-semibold tracking-tight transition-colors disabled:opacity-50';
  if (!acct.owner) {
    return <button disabled className={`${base} bg-white/5 text-text-3`}>Connect your wallet to trade</button>;
  }
  if (!acct.wrapperExists) {
    return (
      <button onClick={() => acct.createAccount()} disabled={!!acct.busy} className={`${base} bg-(--accent-soft) text-up`}>
        {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
      </button>
    );
  }
  if (!quotable) {
    return <button disabled className={`${base} bg-white/5 text-text-3`}>Strike too far from price to quote</button>;
  }
  if (countdown <= 0) {
    return <button disabled className={`${base} bg-white/5 text-text-3`}>Market expired — pick another</button>;
  }
  return (
    <button onClick={onMint} disabled={!!acct.busy} className={`${base} bg-(--accent-soft) text-up`}>
      {acct.busy === 'mint' || acct.busy === 'deposit'
        ? 'Confirming…'
        : shortfall > 0n
          ? `Deposit & mint`
          : 'Mint position'}
    </button>
  );
}

function DirBtn({ active, tone, label, sub, onClick }: { active: boolean; tone: 'up' | 'down'; label: string; sub: string; onClick: () => void }) {
  const color = tone === 'up' ? 'text-up' : 'text-down';
  return (
    <button
      onClick={onClick}
      className={`flex flex-col items-center rounded-lg py-2 transition-colors ${active ? 'bg-white/5' : 'hover:bg-white/3'}`}
    >
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

function Stepper({ value, onDec, onInc }: { value: string; onDec: () => void; onInc: () => void }) {
  return (
    <div className="flex items-center gap-1">
      <StepBtn onClick={onDec}>−</StepBtn>
      <span className="min-w-20 text-center font-mono text-[13px] tabular-nums text-text-1">{value}</span>
      <StepBtn onClick={onInc}>+</StepBtn>
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

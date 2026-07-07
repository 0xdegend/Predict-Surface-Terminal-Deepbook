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
 *
 * Mint goes through a review step (MintConfirmModal) then a celebratory
 * success modal (MintSuccessModal) — same shape as the legacy ticket, reusing
 * both components directly (they're deployment-agnostic presentation). Unlike
 * legacy there's no async re-quote-before-submit step: v2's pricing is already
 * synchronous off the live Pricer on every render, so what's on screen at
 * confirm time is what gets submitted.
 */
import { useState } from 'react';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useNow } from '@/lib/hooks/use-now';
import { upFair, dnFair, type SviFloat } from '@/lib/svi/svi';
import { fromFloat, toFloat, fromQuote, toQuote } from '@/config/scale';
import { dateUTC, countdown } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { isClosingSoon, isTooCloseToExpiry } from '@/lib/markets/v2-discovery';
import {
  snapStrikeToAdmission,
  binaryTicks,
  leverageScaled,
  maxProbabilityWithSlippage,
  maxCostWithSlippage,
} from '@/lib/sui/v2/ticks';
import { quantityForStake } from '@/lib/sui/v2/quote';
import { V2PayoutSlider } from './ticket/payout-slider';
import { TicketGuide } from '@/app/_components/ticket-guide';
import { TicketEmpty } from '@/app/_components/ticket-empty';
import { MintConfirmModal, type ConfirmRow } from '@/app/_components/mint-confirm-modal';
import { MintSuccessModal } from '@/app/_components/mint-success-modal';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const SLIPPAGE_BPS = 100; // 1% cost-cap headroom
const AMOUNT_PRESETS = [1, 5, 10, 25];

export function V2TradeTicket({
  market,
  pricer,
  serverNow,
}: {
  market: V2Market | null;
  pricer?: LivePricer;
  serverNow: number;
}) {
  const acct = usePredictAccountV2();
  const now = useNow(serverNow);
  const isUp = useV2TradeStore((s) => s.isUp);
  const setIsUp = useV2TradeStore((s) => s.setIsUp);
  const strikeOffset = useV2TradeStore((s) => s.strikeOffset);
  const nudgeStrike = useV2TradeStore((s) => s.nudgeStrike);
  const setStrikeOffset = useV2TradeStore((s) => s.setStrikeOffset);
  const stake = useV2TradeStore((s) => s.stake);
  const setStake = useV2TradeStore((s) => s.setStake);
  const leverage = useV2TradeStore((s) => s.leverage);
  const setLeverage = useV2TradeStore((s) => s.setLeverage);

  const [confirmOpen, setConfirmOpen] = useState(false);
  const [showCostDetails, setShowCostDetails] = useState(false);
  const [mintSuccess, setMintSuccess] = useState<{
    headline: string;
    tone: 'up' | 'down';
    rows: ConfirmRow[];
    staked: string;
    maxWin: string;
    digest: string;
  } | null>(null);

  if (!acct.owner) {
    return <TicketEmpty />;
  }
  if (!market) {
    return <div className="card px-4 py-6 text-[13px] text-text-3">Pick a market to trade.</div>;
  }
  if (!pricer) {
    return <div className="card px-4 py-6 text-[13px] text-text-3">Loading live price…</div>;
  }

  const svi: SviFloat = pricer.svi;
  const admissionTickSize = BigInt(market.admission_tick_size);
  const admStep = toFloat(market.admission_tick_size);
  const atm = toFloat(snapStrikeToAdmission(fromFloat(pricer.forward), admissionTickSize));
  const strike = atm + strikeOffset * admStep;
  const entryProb = isUp ? upFair(strike, pricer.forward, svi) : dnFair(strike, pricer.forward, svi);

  const stakeBase = toQuote(stake);
  const quantity = quantityForStake(stakeBase, entryProb, leverage); // max payout base units
  const feeBase = BigInt(Math.round(toFloat(market.base_fee) * Number(quantity)));
  const estCostBase = stakeBase + feeBase;
  const maxCost = maxCostWithSlippage(estCostBase, SLIPPAGE_BPS);

  const snapped = snapStrikeToAdmission(fromFloat(strike), admissionTickSize);
  const { lowerTick, higherTick } = binaryTicks(snapped, isUp, BigInt(market.tick_size));
  const maxProbability = maxProbabilityWithSlippage(fromFloat(entryProb), SLIPPAGE_BPS, BigInt(market.max_entry_probability));

  const quotable = entryProb > 0.01 && entryProb < 0.99 && stake > 0;
  const shortfall = maxCost > acct.balanceBase ? maxCost - acct.balanceBase : 0n;
  // How much of the estimated cost the existing account balance covers (the
  // deposit below tops up the rest, plus a little slippage headroom).
  const fundedFromAccount = estCostBase < acct.balanceBase ? estCostBase : acct.balanceBase;
  const maxLev = Math.max(1, Math.floor(toFloat(market.max_admission_leverage)));

  const closingSoon = isClosingSoon(market, now);
  const tooCloseToExpiry = isTooCloseToExpiry(market, now);

  const sym = predictV2Config.quote.symbol;
  const headline = `BTC · ${isUp ? 'UP' : 'DOWN'}`;
  const detailsOpen = showCostDetails || shortfall > 0n;

  function openReview() {
    if (!quotable || tooCloseToExpiry || !!acct.busy) return;
    setConfirmOpen(true);
  }

  async function handleMint() {
    const digest = await acct.mint(
      {
        marketId: market!.expiry_market_id,
        lowerTick,
        higherTick,
        quantity,
        leverage: leverageScaled(leverage),
        maxCost,
        maxProbability,
        deposit: shortfall > 0n ? shortfall : undefined,
      },
      { silentSuccess: true },
    );
    setConfirmOpen(false);
    if (digest) {
      setMintSuccess({
        headline,
        tone: isUp ? 'up' : 'down',
        rows: [
          { label: 'Outcome', value: isUp ? 'Pays if price ends ABOVE' : 'Pays if price ends AT/BELOW' },
          { label: 'Strike', value: `$${strike.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, emphasize: true },
          { label: 'Expiry', value: dateUTC(market!.expiry) },
          ...(leverage > 1 ? [{ label: 'Leverage', value: `${leverage}×` }] : []),
        ],
        staked: `$${fromQuote(estCostBase).toFixed(2)} ${sym}`,
        maxWin: `$${fromQuote(quantity).toFixed(2)} ${sym}`,
        digest,
      });
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <TicketGuide
        step={stake > 0 ? (confirmOpen ? 3 : 2) : 1}
        mode="binary"
        storageKey="skew:v2-ticket-guide-dismissed"
        copy={{
          steps: ['Pick a direction and strike', 'Set your stake and leverage', 'Review and confirm'],
          tip: 'Tip: leverage multiplies your payout for the same stake, but the position closes early if price moves far enough against you.',
        }}
      />

      <div className="flex items-center justify-between">
        <h3 className="text-[14px] font-medium tracking-tight text-text-1">Trade</h3>
        <span className="font-mono text-[11px] text-text-3">${pricer.forward.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      </div>

      {/* direction */}
      <div className="grid grid-cols-2 gap-2">
        <DirBtn active={isUp} tone="up" label="Up" sub={`${(upFair(strike, pricer.forward, svi) * 100).toFixed(1)}%`} onClick={() => setIsUp(true)} />
        <DirBtn active={!isUp} tone="down" label="Down" sub={`${(dnFair(strike, pricer.forward, svi) * 100).toFixed(1)}%`} onClick={() => setIsUp(false)} />
      </div>

      {/* strike — drag-to-payout slider, bounded to the quotable band */}
      <V2PayoutSlider
        forward={pricer.forward}
        svi={svi}
        isUp={isUp}
        atm={atm}
        admStep={admStep}
        admissionTickSize={admissionTickSize}
        strikeOffset={strikeOffset}
        onChange={setStrikeOffset}
      />
      {/* fine +/- 1-tick nudge, alongside the slider like legacy */}
      <div className="flex items-center justify-end gap-1 -mt-2">
        <button onClick={() => nudgeStrike(-1)} className="ctrl-soft h-6 w-6 rounded-md text-[13px] text-text-2 transition-colors hover:text-text-1">
          −
        </button>
        <button onClick={() => nudgeStrike(1)} className="ctrl-soft h-6 w-6 rounded-md text-[13px] text-text-2 transition-colors hover:text-text-1">
          +
        </button>
      </div>

      {/* stake — "you pay" */}
      <div className="flex flex-col gap-1.5">
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
        <div className="flex gap-1.5">
          {AMOUNT_PRESETS.map((n) => (
            <button
              key={n}
              onClick={() => setStake(n)}
              className={`flex-1 rounded-md py-1.5 text-[11px] tabular-nums transition-colors ${
                stake === n ? 'border border-up/40 bg-(--accent-soft) text-accent' : 'ctrl-soft text-text-3'
              }`}
            >
              ${n}
            </button>
          ))}
        </div>
      </div>

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

      {/* summary + collapsible cost details */}
      <div className="flex flex-col gap-1.5 border-t border-line-soft pt-3 font-mono text-[12px] tabular-nums">
        <SumRow label="Entry odds" value={`${(entryProb * 100).toFixed(2)}%`} />
        <SumRow label="Max payout" value={`$${fromQuote(quantity).toLocaleString(undefined, { maximumFractionDigits: 2 })}`} />
        <SumRow label="Cost cap" value={`$${fromQuote(maxCost).toFixed(2)}`} muted />

        <button
          type="button"
          onClick={() => setShowCostDetails((v) => !v)}
          aria-expanded={detailsOpen}
          className="mt-1 flex items-center justify-between rounded-md py-1 text-[11px] text-text-3 transition-colors hover:text-text-2"
        >
          <span>Cost details</span>
          <span className="tabular-nums text-text-3">{detailsOpen ? '−' : '+'}</span>
        </button>
        {detailsOpen && (
          <div className="glass-inset flex flex-col gap-2 rounded-lg p-3">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-3">Stake</span>
              <span className="text-[11px] tabular-nums text-text-1">${fromQuote(stakeBase).toFixed(2)}</span>
            </div>
            {feeBase > 0n && (
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">Protocol fee</span>
                <span className="text-[11px] tabular-nums text-text-1">+${fromQuote(feeBase).toFixed(2)}</span>
              </div>
            )}
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-3">From your trading account</span>
              <span className="text-[11px] tabular-nums text-text-1">${fromQuote(fundedFromAccount).toFixed(2)}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-3">Deposit needed from wallet</span>
              <span className="text-[11px] tabular-nums text-text-1">${fromQuote(shortfall).toFixed(2)}</span>
            </div>
            {shortfall > 0n && (
              <span className="text-[10px] leading-relaxed text-text-3">
                Not enough in your trading account — the shortfall deposits from your wallet in the same
                transaction.
              </span>
            )}
          </div>
        )}
      </div>

      {/* near-expiry caution — mint is blocked outright inside the cadence's final window */}
      {(closingSoon || tooCloseToExpiry) && (
        <div className="rounded border border-down/40 bg-down/10 p-2 text-[11px] leading-relaxed text-down">
          {tooCloseToExpiry
            ? 'Too close to expiry to mint — a transaction can’t land in time. Pick another market.'
            : `Closing in ${countdown(market.expiry, now)} — a mint may revert if the market settles before your transaction lands on-chain.`}
        </div>
      )}

      <ActionButton acct={acct} quotable={quotable} tooCloseToExpiry={tooCloseToExpiry} onReview={openReview} shortfall={shortfall} />
      {acct.error && <p className="text-[11px] leading-relaxed text-down">{acct.error}</p>}
      <p className="text-[10px] leading-relaxed text-text-3">
        Cost is an estimate; your wallet shows the exact amount before you approve.
      </p>

      <MintConfirmModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={handleMint}
        busy={acct.busy === 'mint' || acct.busy === 'create'}
        headline={headline}
        tone={isUp ? 'up' : 'down'}
        rows={[
          { label: 'Outcome', value: isUp ? 'Pays if price ends ABOVE' : 'Pays if price ends AT/BELOW' },
          { label: 'Strike', value: `$${strike.toLocaleString(undefined, { maximumFractionDigits: 0 })}`, emphasize: true },
          { label: 'Expiry', value: `${dateUTC(market.expiry)} · ${countdown(market.expiry, now)}` },
          ...(leverage > 1 ? [{ label: 'Leverage', value: `${leverage}×` }] : []),
          ...(feeBase > 0n ? [{ label: 'Protocol fee', value: `$${fromQuote(feeBase).toFixed(2)} ${sym}` }] : []),
        ]}
        cost={`$${fromQuote(estCostBase).toFixed(2)} ${sym}`}
        maxWin={`$${fromQuote(quantity).toFixed(2)} ${sym}`}
        confirmLabel={`Mint ${isUp ? 'UP' : 'DOWN'}`}
        subtitle={
          acct.gasless
            ? 'Signed in with Google — mints instantly, no wallet pop-up'
            : 'Review your position, then approve it in your wallet'
        }
      />

      {mintSuccess && (
        <MintSuccessModal
          open={!!mintSuccess}
          onClose={() => setMintSuccess(null)}
          headline={mintSuccess.headline}
          tone={mintSuccess.tone}
          rows={mintSuccess.rows}
          staked={mintSuccess.staked}
          maxWin={mintSuccess.maxWin}
          digest={mintSuccess.digest}
          network={predictV2Config.network}
          positionsHref="/v2/portfolio"
        />
      )}
    </div>
  );
}

function ActionButton({
  acct,
  quotable,
  tooCloseToExpiry,
  onReview,
  shortfall,
}: {
  acct: ReturnType<typeof usePredictAccountV2>;
  quotable: boolean;
  tooCloseToExpiry: boolean;
  onReview: () => void;
  shortfall: bigint;
}) {
  const base = 'w-full rounded-lg px-4 py-2.5 text-[13px] font-semibold tracking-tight transition-colors disabled:opacity-50';
  if (!acct.wrapperExists)
    return (
      <button onClick={() => acct.createAccount()} disabled={!!acct.busy} className={`${base} bg-(--accent-soft) text-up`}>
        {acct.busy === 'create' ? 'Creating account…' : 'Create trading account'}
      </button>
    );
  if (tooCloseToExpiry) return <button disabled className={`${base} bg-white/5 text-text-3`}>Too close to expiry</button>;
  if (!quotable) return <button disabled className={`${base} bg-white/5 text-text-3`}>Strike too far from price to quote</button>;
  return (
    <button onClick={onReview} disabled={!!acct.busy} className={`${base} bg-(--accent-soft) text-up`}>
      {acct.busy === 'mint' || acct.busy === 'deposit' ? 'Confirming…' : shortfall > 0n ? 'Review deposit & mint' : 'Review'}
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

function SumRow({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? 'text-text-3' : 'text-text-2'}>{label}</span>
      <span className={muted ? 'text-text-3' : 'text-text-1'}>{value}</span>
    </div>
  );
}

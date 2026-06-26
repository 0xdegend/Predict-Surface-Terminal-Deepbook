'use client';

/**
 * Range trade ticket — the vertical-range counterpart to the binary block in
 * FlowPanel. The user picks a band (two prices) on the odds curve; this quotes
 * it chain-authoritatively via `quoteRange` (get_range_trade_amounts) and mints
 * with `acct.mintRange` → buildMintRangeTx. Pays $1·qty if settlement ∈ (lower,
 * higher]. Tradeability is gated on the client range-fair (a wide 0.2%–99.8%
 * pre-filter; the chain quote is the true gate) so we never
 * fire a doomed simulate for a degenerate band.
 */
import { useState } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { predictConfig } from '@/config/predict';
import { fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote, feeAmount, price, pct, signed } from '@/lib/format';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { quoteRange, solveQuoteForStake, type StakeQuote } from '@/lib/sui/quote';
import { fundingSplit, feeRouterPayment, skewFee } from '@/lib/sui/funding';
import { useSkewFee } from '@/lib/hooks/use-skew-fee';
import { humanizeError } from '@/lib/sui/abort';
import { rangeFair } from '@/lib/svi/svi';
import { isTradeableFair, type SmileInput } from '@/lib/svi/surface';
import { MintConfirmModal } from './mint-confirm-modal';
import { SmileStrip } from './smile-strip';
import { dateUTC, countdown } from '@/lib/format';

/** Final-seconds hard cutoff before expiry (mirrors FlowPanel's MINT_CUTOFF_MS). */
const MINT_CUTOFF_MS = 5_000;

export function RangeTicket({ active, now }: { active: SmileInput; now: number }) {
  const client = useCurrentClient();
  const acct = usePredictAccount();
  const band = useSurfaceStore((s) => s.rangeSelection);
  const anchor = useSurfaceStore((s) => s.rangeAnchor);
  const pulseFill = useSurfaceStore((s) => s.pulseFill);
  const [betInput, setBetInput] = useState(1); // DUSDC the user wants to bet (stake)

  // Everyone reviews the trade in a modal before minting (the in-app preview
  // gasless Google/zkLogin accounts always needed, now shown for all wallets).
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Live Skew builder fee (bps); >0 routes through the on-chain fee router.
  const { feeBps } = useSkewFee();

  // True while re-quoting the chain right before submit (mirrors the binary ticket).
  const [preparing, setPreparing] = useState(false);

  // Cost breakdown collapsed by default (mirrors the binary ticket) — opens
  // automatically when funds are short so that blocker is never hidden.
  const [showCostDetails, setShowCostDetails] = useState(false);

  const oracle = active.oracle;
  const sym = predictConfig.quote.symbol;
  const msLeft = oracle.expiry - now;
  const expired = msLeft <= 0;
  // Inside the final-seconds cutoff a sponsored mint can't land in time — block it.
  const tooCloseToExpiry = msLeft > 0 && msLeft < MINT_CUTOFF_MS;
  const mintLocked = expired || tooCloseToExpiry;

  const hasBand = !!band && band.oracleId === oracle.oracle_id;

  const fair = hasBand
    ? rangeFair(band!.lower, band!.higher, active.forward, active.svi, active.settlement ?? null)
    : 0;
  const tradeable = hasBand && isTradeableFair(fair);
  // The user bets a dollar amount and pays EXACTLY that: we solve for the size
  // whose chain cost equals the stake (cost is fixed, the *payout* floats). The
  // range-fair gives the seed; keying the query on the stake (not the solved qty)
  // keeps it stable. On-chain quantity == payout in dollars.
  const betAmount = Math.max(0, betInput);
  const stakeBase = toQuote(betAmount);
  const unitPrice = fair > 0 ? Math.min(0.99, Math.max(0.01, fair)) : 0.5;
  const qtyGuess = toQuote(betAmount / unitPrice);

  const quoteQ = useQuery({
    queryKey: [
      'range-quote',
      oracle.oracle_id,
      band?.lowerScaled ?? '',
      band?.higherScaled ?? '',
      stakeBase.toString(),
      acct.owner,
    ],
    queryFn: () =>
      solveQuoteForStake(
        (quantity) =>
          quoteRange(client.core, {
            sender: acct.owner!,
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            lowerStrike: BigInt(band!.lowerScaled),
            higherStrike: BigInt(band!.higherScaled),
            quantity,
          }),
        stakeBase,
        qtyGuess,
      ),
    enabled: !!acct.owner && hasBand && tradeable && !expired,
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  const q: StakeQuote | undefined = tradeable ? quoteQ.data : undefined;

  // Solved position size we actually mint, and its dollar payout ("You win").
  const qtyBase = q?.quantity ?? 0n;
  const payoutDollars = q ? fromQuote(q.quantity) : 0;

  // DUSDC pulled from the connected WALLET for this mint (manager free balance
  // covers the rest). Gate the button on it so a wallet that can't cover its
  // share can't fire a doomed mint.
  const walletNow = q
    ? feeBps > 0
      ? feeRouterPayment(q.mintCost, acct.tradingBalanceBase, feeBps).paymentAmount
      : fundingSplit(q.mintCost, acct.tradingBalanceBase).depositAmount
    : 0n;
  const insufficient =
    !!q && acct.dusdcBalance !== undefined && walletNow > acct.dusdcBalance;

  // Open the review modal — the final step for everyone now (matches the binary
  // ticket's preview-before-mint). handleMint runs after the user confirms.
  function openReview() {
    if (!q || !tradeable || mintLocked || insufficient || acct.busy === 'mint-range' || preparing) return;
    setConfirmOpen(true);
  }

  async function handleMint() {
    if (!q || !band || mintLocked || insufficient) return;
    setPreparing(true);
    try {
      // Re-solve against the chain right before submitting — pins the cost to the
      // user's stake at the moment of minting, and the fresh, authoritative cost
      // sizes funding (a stale 5s-polled cost under-funds the deposit and aborts).
      let fresh: StakeQuote;
      try {
        fresh = await solveQuoteForStake(
          (quantity) =>
            quoteRange(client.core, {
              sender: acct.owner!,
              oracleId: oracle.oracle_id,
              expiry: oracle.expiry,
              lowerStrike: BigInt(band.lowerScaled),
              higherStrike: BigInt(band.higherScaled),
              quantity,
            }),
          stakeBase,
          qtyBase > 0n ? qtyBase : qtyGuess,
        );
      } catch {
        setConfirmOpen(false);
        acct.setError('Couldn’t refresh the price — the market may have just moved or expired. Try again.');
        return;
      }
      const digest =
        feeBps > 0
          ? await acct.mintRangeWithFee({
              oracleId: oracle.oracle_id,
              expiry: oracle.expiry,
              lowerStrike: BigInt(band.lowerScaled),
              higherStrike: BigInt(band.higherScaled),
              quantity: fresh.quantity,
              paymentAmount: feeRouterPayment(fresh.mintCost, acct.tradingBalanceBase, feeBps).paymentAmount,
            })
          : await acct.mintRange({
              oracleId: oracle.oracle_id,
              expiry: oracle.expiry,
              lowerStrike: BigInt(band.lowerScaled),
              higherStrike: BigInt(band.higherScaled),
              quantity: fresh.quantity,
              depositAmount: fundingSplit(fresh.mintCost, acct.tradingBalanceBase).depositAmount,
            });
      setConfirmOpen(false);
      if (digest) {
        pulseFill({ oracleId: oracle.oracle_id, strike: (band.lower + band.higher) / 2, isUp: true });
      }
    } finally {
      setPreparing(false);
    }
  }

  // No band yet → tap two levels on the embedded odds curve (self-contained, so
  // it works inside the mobile drawer where the rail curve is out of reach).
  if (!hasBand) {
    const anchored = anchor && anchor.oracleId === oracle.oracle_id;
    return (
      <div className="flex flex-col gap-2">
        {/* Prominent instruction callout (accent bar + bright text) so it's
            obvious how to build a range — not a faint grey line. */}
        <div className="flex items-start gap-2.5 rounded-lg border border-up/30 bg-(--accent-soft) p-2.5">
          <span aria-hidden className="mt-0.5 h-3.5 w-px shrink-0 bg-accent" />
          <p className="text-[12px] leading-relaxed text-text-1">
            {anchored ? (
              <>
                Lower level set at{' '}
                <span className="tabular-nums text-accent">{price(anchor!.strike)}</span> — now tap
                the <span className="text-accent">upper</span> price on the curve.
              </>
            ) : (
              <>
                Tap <span className="text-accent">two price levels</span> on the curve to bet{' '}
                {oracle.underlying_asset} settles between them.
              </>
            )}
          </p>
        </div>
        <SmileStrip input={active} />
      </div>
    );
  }

  const cost = q ? fromQuote(q.mintCost) : 0;
  const maxPayout = payoutDollars; // what you win if the band hits
  const feeF = q ? fromQuote(skewFee(q.mintCost, feeBps)) : 0;
  const profit = maxPayout - cost - feeF; // net of the Skew fee too
  const mult = cost + feeF > 0 ? maxPayout / (cost + feeF) : 0;
  const chance = q ? Number((q.mintCost * 1_000_000_000n) / qtyBase) / 1e9 : fair;
  // Breakdown collapsed by default; force open when funds are short.
  const detailsOpen = showCostDetails || insufficient;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-text-2">
        Win if <span className="text-text-1">{oracle.underlying_asset}</span> settles{' '}
        <span className="text-accent">
          between {price(band!.lower)} and {price(band!.higher)}
        </span>{' '}
        at expiry.
      </p>

      {/* The band lives on the curve: drag either edge handle to adjust it (works
          on touch too), tap elsewhere to re-pick, or Reset on the chart. This is
          the only band control now — no separate steppers. */}
      <SmileStrip input={active} />

      {/* Bet amount — a dollar stake; sized to a mintable position under the hood. */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-text-3">Bet amount</span>
          <div className="ctrl-soft inline-flex items-center gap-1 rounded-md px-2 py-1 focus-within:border-white/20">
            <input
              type="number"
              min={0}
              step={1}
              value={betInput}
              onChange={(e) => setBetInput(Math.max(0, Number(e.target.value) || 0))}
              className="w-16 bg-transparent text-right text-text-1 outline-none"
              aria-label={`Bet amount in ${sym}`}
            />
            <span className="text-[10px] text-text-3">{sym}</span>
          </div>
        </div>
        <div className="flex gap-1.5">
          {[1, 5, 10, 25].map((n) => (
            <button
              key={n}
              onClick={() => setBetInput(n)}
              className={`flex-1 rounded-md py-1.5 text-[11px] tabular-nums transition-colors ${
                betInput === n
                  ? 'border border-up/40 bg-[var(--accent-soft)] text-accent'
                  : 'ctrl-soft text-text-3'
              }`}
            >
              ${n}
            </button>
          ))}
        </div>
      </div>

      {/* Risk → reward */}
      <div className={`glass-card p-3.5 ${q && tradeable && !expired ? 'up glow-accent' : ''}`}>
        {expired ? (
          <span className="text-text-3">
            This market has expired and is awaiting settlement — pick another expiry.
          </span>
        ) : !tradeable ? (
          <span className="text-text-3">
            This band is too far from spot (or too wide) to quote — narrow it toward{' '}
            {price(active.forward)} (only odds away from the 0%/100% extremes can be priced).
          </span>
        ) : !q ? (
          quoteQ.isError ? (
            <span className="text-down">{humanizeError(quoteQ.error)}</span>
          ) : (
            <span className="text-text-3">quoting…</span>
          )
        ) : (
          <div className="flex flex-col">
            <div className="grid grid-cols-2 gap-3">
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">You pay</span>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[22px] leading-none text-text-1">{fmtQuote(cost)}</span>
                  <span className="text-[11px] leading-none text-text-3">{sym}</span>
                </span>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="eyebrow">You win</span>
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[22px] leading-none text-up">{fmtQuote(maxPayout)}</span>
                  <span className="text-[11px] leading-none text-text-3">{sym}</span>
                  <span className="rounded bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] leading-none text-up">
                    {mult.toFixed(2)}×
                  </span>
                </span>
              </div>
            </div>
            <span className="mt-2 text-[10px] text-text-3">
              net profit if right <span className="text-up">{signed(profit)}</span>
            </span>

            <div className="mt-3 flex flex-col gap-1.5">
              <div className="flex items-center justify-between">
                <span className="eyebrow">Implied chance</span>
                <span className="text-[12px] tabular-nums text-text-2">{pct(chance, 1)}</span>
              </div>
              <div className="meter">
                <i
                  style={{
                    width: `${Math.min(100, Math.max(0, chance * 100))}%`,
                    background: 'var(--up)',
                  }}
                />
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowCostDetails((v) => !v)}
              aria-expanded={detailsOpen}
              className="mt-3 flex items-center justify-between rounded-md px-1 py-1 text-[11px] text-text-3 transition-colors hover:text-text-2"
            >
              <span>Cost details</span>
              <span className="tabular-nums text-text-3">{detailsOpen ? '−' : '+'}</span>
            </button>
            {detailsOpen && (
            <div className="glass-inset mt-1 flex flex-col gap-2 p-3">
              {feeBps > 0 && (
                <>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-text-3">Skew fee · {(feeBps / 100).toFixed(2)}%</span>
                    <span className="text-[11px] tabular-nums text-text-1">+{feeAmount(feeF)} {sym}</span>
                  </div>
                  <span className="text-[10px] leading-relaxed text-text-3">
                    Bet cost goes to the DeepBook Predict vault; the Skew fee goes to Skew.
                  </span>
                </>
              )}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-3">Leaves your wallet now</span>
                <span className={`text-[11px] tabular-nums ${insufficient ? 'text-down' : 'text-text-1'}`}>
                  {walletNow > 0n ? '≈ ' : ''}
                  {fmtQuote(fromQuote(walletNow))} {sym}
                </span>
              </div>
              {insufficient && (
                <span className="text-[10px] leading-relaxed text-down">
                  That’s more than your {fmtQuote(fromQuote(acct.dusdcBalance ?? 0n))} {sym} wallet
                  balance — add {sym} or lower your bet.
                </span>
              )}
            </div>
            )}
          </div>
        )}
      </div>

      <button
        onClick={openReview}
        disabled={!q || !tradeable || mintLocked || insufficient || acct.busy === 'mint-range' || preparing}
        className="group relative flex items-center justify-center gap-2 overflow-hidden rounded-lg border border-up/50 bg-linear-to-b from-up/25 to-up/10 px-3 py-3 text-[13px] font-semibold text-up shadow-[0_0_24px_-6px_var(--accent-glow)] transition-all hover:from-up/35 hover:to-up/15 disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3 disabled:shadow-none"
      >
        {expired
          ? 'Market expired'
          : tooCloseToExpiry
            ? 'Too close to expiry'
            : insufficient
              ? `Insufficient ${sym} — need ${fmtQuote(fromQuote(walletNow))}`
              : q
                ? `Review · pay ${fmtQuote(cost)} → win ${fmtQuote(maxPayout)}`
                : 'Review bet'}
      </button>

      {q && band && (
        <MintConfirmModal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={handleMint}
          busy={acct.busy === 'mint-range' || preparing}
          headline={`${oracle.underlying_asset} · Range`}
          tone="up"
          rows={[
            { label: 'Outcome', value: 'Pays if price ends in band' },
            { label: 'Band', value: `${price(band.lower)} – ${price(band.higher)}`, emphasize: true },
            { label: 'Expiry', value: `${dateUTC(oracle.expiry)} · ${countdown(oracle.expiry, now)}` },
            ...(feeBps > 0 ? [{ label: `Skew fee (${(feeBps / 100).toFixed(2)}%)`, value: `${feeAmount(feeF)} ${sym}` }] : []),
          ]}
          cost={fmtQuote(cost)}
          maxWin={fmtQuote(maxPayout)}
          confirmLabel="Mint range"
        />
      )}
    </div>
  );
}

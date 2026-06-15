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
import { useIsEnokiWallet } from '@/lib/hooks/use-is-enoki';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { quoteRange, type TradeQuote } from '@/lib/sui/quote';
import { fundingSplit, feeRouterPayment, skewFee } from '@/lib/sui/funding';
import { useSkewFee } from '@/lib/hooks/use-skew-fee';
import { humanizeError } from '@/lib/sui/abort';
import { rangeFair } from '@/lib/svi/svi';
import { isTradeableFair, type SmileInput } from '@/lib/svi/surface';
import { MintConfirmModal } from './mint-confirm-modal';
import { dateUTC, countdown } from '@/lib/format';

/** Final-seconds hard cutoff before expiry (mirrors FlowPanel's MINT_CUTOFF_MS). */
const MINT_CUTOFF_MS = 5_000;

export function RangeTicket({ active, now }: { active: SmileInput; now: number }) {
  const client = useCurrentClient();
  const acct = usePredictAccount();
  const band = useSurfaceStore((s) => s.rangeSelection);
  const anchor = useSurfaceStore((s) => s.rangeAnchor);
  const clearRange = useSurfaceStore((s) => s.clearRange);
  const pulseFill = useSurfaceStore((s) => s.pulseFill);
  const [contractsInput, setContractsInput] = useState(1);

  // Gasless Google/zkLogin mints have no wallet pop-up → confirm in-app first.
  const isEnoki = useIsEnokiWallet();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Live Skew builder fee (bps); >0 routes through the on-chain fee router.
  const { feeBps } = useSkewFee();

  // True while re-quoting the chain right before submit (mirrors the binary ticket).
  const [preparing, setPreparing] = useState(false);

  const oracle = active.oracle;
  const sym = predictConfig.quote.symbol;
  const msLeft = oracle.expiry - now;
  const expired = msLeft <= 0;
  // Inside the final-seconds cutoff a sponsored mint can't land in time — block it.
  const tooCloseToExpiry = msLeft > 0 && msLeft < MINT_CUTOFF_MS;
  const mintLocked = expired || tooCloseToExpiry;

  const hasBand = !!band && band.oracleId === oracle.oracle_id;
  const contracts = Math.max(1, contractsInput);
  const qtyBase = toQuote(contracts);
  const fair = hasBand
    ? rangeFair(band!.lower, band!.higher, active.forward, active.svi, active.settlement ?? null)
    : 0;
  const tradeable = hasBand && isTradeableFair(fair);

  const quoteQ = useQuery({
    queryKey: [
      'range-quote',
      oracle.oracle_id,
      band?.lowerScaled ?? '',
      band?.higherScaled ?? '',
      qtyBase.toString(),
      acct.owner,
    ],
    queryFn: () =>
      quoteRange(client.core, {
        sender: acct.owner!,
        oracleId: oracle.oracle_id,
        expiry: oracle.expiry,
        lowerStrike: BigInt(band!.lowerScaled),
        higherStrike: BigInt(band!.higherScaled),
        quantity: qtyBase,
      }),
    enabled: !!acct.owner && hasBand && tradeable && !expired,
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  const q = tradeable ? quoteQ.data : undefined;

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

  function requestMint() {
    if (!q || !tradeable || mintLocked || insufficient || acct.busy === 'mint-range' || preparing) return;
    if (isEnoki) setConfirmOpen(true);
    else handleMint();
  }

  async function handleMint() {
    if (!q || !band || mintLocked || insufficient) return;
    setPreparing(true);
    try {
      // Re-quote against the chain right before submitting — a stale (5s-polled)
      // cost under-funds the deposit and the mint aborts. Size funding from this
      // fresh, authoritative cost.
      let fresh: TradeQuote;
      try {
        fresh = await quoteRange(client.core, {
          sender: acct.owner!,
          oracleId: oracle.oracle_id,
          expiry: oracle.expiry,
          lowerStrike: BigInt(band.lowerScaled),
          higherStrike: BigInt(band.higherScaled),
          quantity: qtyBase,
        });
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
              quantity: qtyBase,
              paymentAmount: feeRouterPayment(fresh.mintCost, acct.tradingBalanceBase, feeBps).paymentAmount,
            })
          : await acct.mintRange({
              oracleId: oracle.oracle_id,
              expiry: oracle.expiry,
              lowerStrike: BigInt(band.lowerScaled),
              higherStrike: BigInt(band.higherScaled),
              quantity: qtyBase,
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

  // No band yet → guide the pick on the odds curve.
  if (!hasBand) {
    return (
      <div className="glass-inset flex flex-col gap-1.5 p-3 text-[11px] leading-relaxed text-text-3">
        <span className="text-text-2">Pick your range on the odds curve above.</span>
        <span>
          {anchor && anchor.oracleId === oracle.oracle_id
            ? `Lower bound set at ${price(anchor.strike)} — now click the upper price.`
            : `Click two price levels to bet ${oracle.underlying_asset} settles between them.`}
        </span>
      </div>
    );
  }

  const cost = q ? fromQuote(q.mintCost) : 0;
  const maxPayout = contracts; // each contract pays 1.00 if the band hits
  const feeF = q ? fromQuote(skewFee(q.mintCost, feeBps)) : 0;
  const profit = maxPayout - cost - feeF; // net of the Skew fee too
  const mult = cost + feeF > 0 ? maxPayout / (cost + feeF) : 0;
  const chance = q ? Number((q.mintCost * 1_000_000_000n) / qtyBase) / 1e9 : fair;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-[11px] leading-relaxed text-text-3">
        Pays <span className="text-text-1">1.00 {sym}</span> per contract if{' '}
        <span className="text-text-2">{oracle.underlying_asset}</span> settles{' '}
        <span className="text-accent">
          between {price(band!.lower)} and {price(band!.higher)}
        </span>{' '}
        at expiry. Otherwise it expires worthless.
      </p>

      <div className="flex items-center justify-between">
        <span className="eyebrow">Your band</span>
        <button
          onClick={clearRange}
          className="ctrl-soft rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-3"
        >
          reset
        </button>
      </div>
      <div className="glass-inset flex items-center justify-between px-3 py-2 text-[13px] tabular-nums text-text-1">
        <span>{price(band!.lower)}</span>
        <span className="text-text-3">—</span>
        <span>{price(band!.higher)}</span>
      </div>

      {/* Contracts */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <span className="text-text-3">Contracts</span>
          <input
            type="number"
            min={1}
            step={1}
            value={contractsInput}
            onChange={(e) => setContractsInput(Math.max(1, Number(e.target.value) || 1))}
            className="ctrl-soft w-20 rounded-md px-2 py-1 text-right text-text-1 outline-none focus:border-white/20"
          />
        </div>
        <div className="flex gap-1.5">
          {[1, 5, 10, 25].map((n) => (
            <button
              key={n}
              onClick={() => setContractsInput(n)}
              className={`flex-1 rounded-md py-1.5 text-[11px] tabular-nums transition-colors ${
                contractsInput === n
                  ? 'border border-up/40 bg-[var(--accent-soft)] text-accent'
                  : 'ctrl-soft text-text-3'
              }`}
            >
              {n}
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

            <div className="glass-inset mt-3 flex flex-col gap-2 p-3">
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
                  balance — add {sym} or lower the contract size.
                </span>
              )}
            </div>
          </div>
        )}
      </div>

      <button
        onClick={requestMint}
        disabled={!q || !tradeable || mintLocked || insufficient || acct.busy === 'mint-range' || preparing}
        className="group relative flex items-center justify-center gap-2 overflow-hidden rounded-lg border border-up/50 bg-linear-to-b from-up/25 to-up/10 px-3 py-3 text-[13px] font-semibold text-up shadow-[0_0_24px_-6px_var(--accent-glow)] transition-all hover:from-up/35 hover:to-up/15 disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3 disabled:shadow-none"
      >
        {(acct.busy === 'mint-range' || preparing) && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
        )}
        {preparing
          ? 'Refreshing price…'
          : acct.busy === 'mint-range'
            ? 'Confirming in wallet…'
            : expired
              ? 'Market expired'
              : tooCloseToExpiry
                ? 'Too close to expiry'
                : insufficient
                  ? `Insufficient ${sym} — need ${fmtQuote(fromQuote(walletNow))}`
                  : q
                    ? `Mint range · pay ${fmtQuote(cost)} → win ${fmtQuote(maxPayout)}`
                    : 'Mint range'}
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
            { label: 'Contracts', value: String(contracts) },
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

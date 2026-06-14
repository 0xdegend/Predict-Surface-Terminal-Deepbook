'use client';

/**
 * Trade ticket (Phase 4) — pre-filled by clicking a node on the surface, then
 * runs the real round trip: create_manager → deposit → mint → position → redeem,
 * all on testnet. Account state + tx logic live in `usePredictAccount` (shared
 * with the Portfolio page); this component owns the mint-specific UI. Minting a
 * node pulses a fill ripple back on the surface.
 */
import { useMemo, useState } from 'react';
import Link from 'next/link';
import { LuWallet, LuCoins } from 'react-icons/lu';
import { HUE, IconChip } from './ui/metric';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { qk } from '@/lib/api/client';
import { predictConfig } from '@/config/predict';
import { toFloat, fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote, feeAmount, price, pct, signed, dateUTC, countdown } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useIsEnokiWallet } from '@/lib/hooks/use-is-enoki';
import { useLiveOracleData } from '@/lib/hooks/use-live-oracle-data';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { snapStrikeToTick, gridBounds } from '@/lib/keys';
import { quoteMarket, type TradeQuote } from '@/lib/sui/quote';
import { fundingSplit, feeRouterPayment, skewFee } from '@/lib/sui/funding';
import { humanizeError } from '@/lib/sui/abort';
import { upFair } from '@/lib/svi/svi';
import { buildMintTx, buildMintWithFeeTx } from '@/lib/sui/predict-tx';
import { useSkewFee } from '@/lib/hooks/use-skew-fee';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { RangeTicket } from './range-ticket';
import { MintConfirmModal } from './mint-confirm-modal';
import { RedeemModal } from './positions/redeem-modal';
import { RangeRedeemModal } from './positions/range-redeem-modal';
import { positionMetrics } from './positions/position-metrics';
import { useRangePositions, type ValuedRangePosition } from '@/lib/hooks/use-range-positions';
import { isTradeableFair, type SmileInput } from '@/lib/svi/surface';
import type { PositionSummary } from '@/lib/api/types';

const EXPLORER = (digest: string) => `https://suiscan.xyz/testnet/tx/${digest}`;

/** Markets inside this window are about to settle — minting may revert. */
const CLOSING_SOON_MS = 120_000;

export function FlowPanel({ inputs: initialInputs, serverNow }: { inputs: SmileInput[]; serverNow: number }) {
  const client = useCurrentClient();
  const now = useNow(serverNow);
  const mounted = useMounted();
  const acct = usePredictAccount();
  // Live oracle set (shared with the table) so a freshly-opened market clicked
  // in the table loads here too — not just the markets present at page load.
  const initialOracles = useMemo(() => initialInputs.map((i) => i.oracle), [initialInputs]);
  const { inputs } = useLiveOracleData(initialOracles, initialInputs);
  const {
    owner,
    managerId,
    summary,
    positions,
    positionsLoading,
    dusdcBalance,
    tradingBalanceBase,
    busy,
    error,
    lastDigest,
    runTx,
    createManager,
    redeem,
    redeemRange,
    managerKeys,
  } = acct;

  const selection = useSurfaceStore((s) => s.selection);
  const rangeSelection = useSurfaceStore((s) => s.rangeSelection);
  const ticketMode = useSurfaceStore((s) => s.ticketMode);
  const setTicketMode = useSurfaceStore((s) => s.setTicketMode);
  const select = useSurfaceStore((s) => s.select);
  const pulseFill = useSurfaceStore((s) => s.pulseFill);

  // Active oracle = the selection for the current ticket mode, falling back to
  // the other mode's selection, then the soonest expiry.
  const active = useMemo(() => {
    const ids =
      ticketMode === 'range'
        ? [rangeSelection?.oracleId, selection?.oracleId]
        : [selection?.oracleId, rangeSelection?.oracleId];
    for (const id of ids) {
      if (id) {
        const found = inputs.find((i) => i.oracle.oracle_id === id);
        if (found) return found;
      }
    }
    return inputs[0];
  }, [selection, rangeSelection, ticketMode, inputs]);

  const [redeeming, setRedeeming] = useState<PositionSummary | null>(null);
  const [redeemingRange, setRedeemingRange] = useState<ValuedRangePosition | null>(null);
  const rangesData = useRangePositions(managerId);

  // Google/zkLogin (Enoki) mints are gasless and sponsored — no wallet pop-up to
  // review the trade — so gate them behind an explicit in-app confirm. Normal
  // wallets skip it; their signing prompt is already the review moment.
  const isEnoki = useIsEnokiWallet();
  const [confirmOpen, setConfirmOpen] = useState(false);

  // Live Skew builder fee (bps). >0 → route the mint through the on-chain fee
  // router so the fee is taken atomically; 0 → plain mint, no fee.
  const { feeBps } = useSkewFee();

  const oracle = active?.oracle;
  const forward = active?.forward ?? 0;
  const grid = useMemo(() => (oracle ? gridBounds(oracle) : null), [oracle]);

  const [strike, setStrike] = useState<bigint>(0n);
  const [isUp, setIsUp] = useState(true);
  const [contractsInput, setContractsInput] = useState(1); // how many contracts to mint

  // Sync the ticket to the active oracle / latest selection by adjusting state
  // during render (React's documented pattern for "reset state on prop change").
  const selKey =
    selection && oracle && selection.oracleId === oracle.oracle_id
      ? `${selection.strikeScaled}:${selection.isUp}`
      : null;
  const [appliedSel, setAppliedSel] = useState<string | null>(null);
  if (oracle) {
    if (selKey && selKey !== appliedSel) {
      setAppliedSel(selKey);
      setStrike(BigInt(selection!.strikeScaled));
      setIsUp(selection!.isUp);
    } else if (!selKey && strike === 0n) {
      setStrike(snapStrikeToTick(BigInt(Math.round(forward * 1e9)), oracle));
    }
  }

  // Flip UP/DOWN. Mirror the choice into the surface store (not just local state)
  // so the directional win-zone on the 3-D surface swings with the toggle.
  function setDirection(nextUp: boolean) {
    setIsUp(nextUp);
    if (oracle && strike > 0n) {
      select({
        oracleId: oracle.oracle_id,
        expiry: oracle.expiry,
        strikeScaled: strike.toString(),
        strike: toFloat(Number(strike)),
        isUp: nextUp,
      });
    }
  }

  // The protocol prices the ask as fair + spread, with a ~1% ask floor; deep
  // OTM/ITM strikes round to 0%/100% and can't be priced. We gate on the client
  // fair price with a deliberately wide band (0.2%–99.8%, see FAIR_TRADE_*): a
  // sub-1% fair can still clear the ask floor once the spread lifts it, so we let
  // it through to the chain-authoritative quote rather than pre-blocking it.
  const strikeFloat = toFloat(Number(strike));
  const clientUp =
    oracle && strike > 0n ? upFair(strikeFloat, forward, active!.svi, active!.settlement ?? null) : null;
  const tradeable = clientUp != null && isTradeableFair(clientUp);

  // Live expiry status — a market at/near expiry will revert on-chain, so we
  // stop quoting and block the mint before the user pays a doomed gas fee.
  const msLeft = oracle ? oracle.expiry - now : 0;
  const expired = !!oracle && msLeft <= 0;
  const closingSoon = !!oracle && msLeft > 0 && msLeft < CLOSING_SOON_MS;

  // The user picks how many contracts; the live quote tells them what they pay.
  const contracts = Math.max(1, contractsInput);
  const qtyBase = toQuote(contracts);

  const quoteQ = useQuery({
    queryKey: ['quote', oracle?.oracle_id, strike.toString(), isUp, qtyBase.toString(), owner],
    queryFn: () =>
      quoteMarket(client.core, {
        sender: owner!,
        oracleId: oracle!.oracle_id,
        expiry: oracle!.expiry,
        strike,
        isUp,
        quantity: qtyBase,
      }),
    enabled: !!owner && !!oracle && strike > 0n && qtyBase > 0n && tradeable && !expired,
    // Keep the last quote on screen while a refetch (or a strike/size change) is
    // in flight, so figures update in place instead of blanking the card.
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  const q: TradeQuote | undefined = tradeable ? quoteQ.data : undefined;

  const tradingBalance = summary?.trading_balance ?? 0; // @6dec base units

  // Entry point for the Mint button. Enoki users see a confirm modal first
  // (no wallet pop-up otherwise); everyone else mints straight through.
  function requestMint() {
    if (!q || !tradeable || expired || busy === 'mint') return;
    if (isEnoki) setConfirmOpen(true);
    else handleMint();
  }

  async function handleMint() {
    if (!managerId || !q || !oracle || expired) return;
    // With a live builder fee, route through the skew_fee router (fee taken
    // on-chain in the same tx); otherwise the plain deposit+mint path.
    const tx =
      feeBps > 0
        ? buildMintWithFeeTx({
            managerId,
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            strike,
            isUp,
            quantity: qtyBase,
            paymentAmount: feeRouterPayment(q.mintCost, tradingBalanceBase, feeBps).paymentAmount,
          })
        : buildMintTx({
            managerId,
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            strike,
            isUp,
            quantity: qtyBase,
            depositAmount: fundingSplit(q.mintCost, tradingBalanceBase).depositAmount,
          });
    const digest = await runTx('mint', tx, [...managerKeys, qk.dusdcBalance(owner ?? '')]);
    setConfirmOpen(false);
    if (digest) pulseFill({ oracleId: oracle.oracle_id, strike: toFloat(Number(strike)), isUp });
  }

  // Until mounted, the connected account is unknown (SSR has no wallet). Render a
  // stable placeholder so the server and first client paint match (no hydration
  // mismatch); the real ticket resolves right after hydration.
  if (!mounted) {
    return <div className="text-[12px] text-text-3">Loading trade ticket…</div>;
  }
  if (!owner) {
    return (
      <div className="text-[12px] text-text-3">
        Connect a wallet (top-right), then click a node on the surface to trade it.
      </div>
    );
  }
  if (!oracle || !grid) {
    return <div className="text-[12px] text-text-3">Waiting for live oracle data…</div>;
  }

  const stepStrike = (dir: 1 | -1) =>
    setStrike((s) => snapStrikeToTick(s + BigInt(dir) * grid.tickSize, oracle));
  const openPositions = positions.filter((p) => p.open_quantity > 0);
  const openRanges = rangesData.positions.filter((p) => p.openQty > 0);
  const fromSurface = !!selection && selection.oracleId === oracle.oracle_id;
  const sym = predictConfig.quote.symbol;

  return (
    <div className="flex flex-col gap-4 font-mono text-[12px] tabular-nums">
      <div className="glass-card flex flex-col gap-2.5 p-2.5">
        <div className={`grid gap-2.5 ${managerId ? 'grid-cols-2' : 'grid-cols-1'}`}>
          <div className="glass-inset flex flex-col gap-2 p-3">
            <div className="flex items-center gap-2">
              <IconChip icon={LuWallet} color={HUE.violet} size={22} />
              <span className="eyebrow">Wallet · {sym}</span>
            </div>
            <span className="text-[18px] leading-none tabular-nums text-text-1">
              {dusdcBalance === undefined ? '…' : fmtQuote(fromQuote(dusdcBalance))}
            </span>
          </div>
          {managerId && (
            <div className="glass-inset flex flex-col gap-2 p-3">
              <div className="flex items-center gap-2">
                <IconChip icon={LuCoins} color={HUE.amber} size={22} />
                <span className="eyebrow">Free balance</span>
              </div>
              <span className="text-[18px] leading-none tabular-nums text-text-1">
                {fmtQuote(fromQuote(tradingBalance))}
              </span>
            </div>
          )}
        </div>
        {dusdcBalance !== undefined && dusdcBalance < 1_000_000n && predictConfig.faucetUrl && (
          <a
            href={predictConfig.faucetUrl}
            target="_blank"
            rel="noreferrer"
            className="px-1 text-[11px] text-accent underline-offset-2 hover:underline"
          >
            Low balance — get testnet DUSDC →
          </a>
        )}
        <div className="flex items-center justify-between px-1 pb-0.5">
          <span className="eyebrow">Manager</span>
          {managerId ? (
            <span className="font-mono text-[11px] tabular-nums text-text-2">
              {managerId.slice(0, 10)}…{managerId.slice(-4)}
            </span>
          ) : (
            <button
              onClick={() => createManager()}
              disabled={busy === 'create'}
              className="ctrl-soft rounded-md px-2.5 py-1 text-[11px] text-accent disabled:opacity-50"
            >
              {busy === 'create' ? 'creating…' : 'Create manager'}
            </button>
          )}
        </div>
      </div>

      {managerId && (
        <div className="glass-divider-top flex flex-col gap-2 pt-3">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[11px] tabular-nums text-text-2">
              {oracle.underlying_asset} · {dateUTC(oracle.expiry)} ·{' '}
              <span className={expired || closingSoon ? 'text-down' : 'text-text-3'}>
                {expired ? 'expired' : `${countdown(oracle.expiry, now)} left`}
              </span>
            </span>
            {fromSurface && (
              <span className="flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-accent">
                <span className="h-1 w-1 rounded-full bg-accent" />
                From surface
              </span>
            )}
          </div>

          {/* Binary (up/down) vs vertical-range mode. */}
          <div className="flex gap-1.5">
            {(['binary', 'range'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setTicketMode(m)}
                aria-pressed={ticketMode === m}
                className={`flex-1 rounded-md py-1.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
                  ticketMode === m
                    ? 'border border-up/40 bg-[var(--accent-soft)] text-accent'
                    : 'ctrl-soft text-text-3'
                }`}
              >
                {m === 'binary' ? 'Up / Down' : 'Range'}
              </button>
            ))}
          </div>

          {ticketMode === 'range' ? (
            <RangeTicket active={active!} now={now} />
          ) : (
            <>
          <div className="flex gap-2">
            <Toggle active={isUp} onClick={() => setDirection(true)} tone="up">
              UP
            </Toggle>
            <Toggle active={!isUp} onClick={() => setDirection(false)} tone="down">
              DOWN
            </Toggle>
          </div>

          {/* Plain-language explainer so a first-time visitor understands the bet. */}
          <p className="text-[11px] leading-relaxed text-text-3">
            Pays{' '}
            <span className="text-text-1">1.00 {predictConfig.quote.symbol}</span> per contract if{' '}
            <span className="text-text-2">{oracle.underlying_asset}</span> settles{' '}
            <span className={isUp ? 'text-up' : 'text-down'}>
              {isUp ? 'above' : 'below'} {price(toFloat(Number(strike)))}
            </span>{' '}
            at expiry. Otherwise it expires worthless.
          </p>

          <Row label={`Strike (settles ${isUp ? 'above' : 'below'})`}>
            <div className="glass-inset inline-flex items-center gap-0.5 rounded-lg p-0.5">
              <button
                onClick={() => stepStrike(-1)}
                aria-label="Lower strike"
                className="ctrl-soft flex h-6 w-6 items-center justify-center rounded-md text-text-2"
              >
                −
              </button>
              <span className="min-w-[5.5rem] text-center text-[13px] text-text-1">
                {price(toFloat(Number(strike)))}
              </span>
              <button
                onClick={() => stepStrike(1)}
                aria-label="Raise strike"
                className="ctrl-soft flex h-6 w-6 items-center justify-center rounded-md text-text-2"
              >
                +
              </button>
            </div>
          </Row>

          {/* Bet size — number of contracts; the live quote below shows the cost. */}
          <div className="flex flex-col gap-1.5">
            <Row label="Contracts">
              <input
                type="number"
                min={1}
                step={1}
                value={contractsInput}
                onChange={(e) => setContractsInput(Math.max(1, Number(e.target.value) || 1))}
                className="ctrl-soft w-20 rounded-md px-2 py-1 text-right text-text-1 outline-none focus:border-white/20"
              />
            </Row>
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
            <span className="text-[10px] text-text-3">
              each contract pays 1.00 {predictConfig.quote.symbol} if it wins · you pay the quote below
            </span>
          </div>

          {/* Risk → Reward: the answer to "what do I pay and what can I win?" */}
          <div
            className={`glass-card p-3.5 ${q && tradeable && !expired ? (isUp ? 'up glow-accent' : 'down glow-down') : ''}`}
          >
            {expired ? (
              <span className="text-text-3">
                This market has expired and is awaiting settlement — pick another expiry on the
                surface or in the table.
              </span>
            ) : !tradeable ? (
              <span className="text-text-3">
                Strike too far from spot to trade — pick one nearer {price(forward)} (only odds away
                from the 0%/100% extremes can be priced).
              </span>
            ) : !q ? (
              // Only surface an error / loading state when we have NO quote to
              // show. A transient devInspect failure during a background refetch
              // keeps the last good quote on screen rather than flashing red.
              quoteQ.isError ? (
                <span className="text-down">{humanizeError(quoteQ.error)}</span>
              ) : (
                <span className="text-text-3">quoting…</span>
              )
            ) : (
              (() => {
                const cost = fromQuote(q.mintCost);
                const maxPayout = contracts; // each contract pays 1.00 if it wins
                const chance = Number((q.mintCost * 1_000_000_000n) / qtyBase) / 1e9;
                // Skew builder fee (on top of the bet) + funding. With a fee, the
                // router takes a single payment coin (fee + deposit); without one,
                // mint pays from the manager free balance first and only the
                // shortfall is pulled from the wallet now.
                const router = feeRouterPayment(q.mintCost, tradingBalanceBase, feeBps);
                const feeF = fromQuote(router.fee);
                const profit = maxPayout - cost - feeF; // net of the Skew fee too
                const mult = cost + feeF > 0 ? maxPayout / (cost + feeF) : 0;
                const walletNow =
                  feeBps > 0 ? router.paymentAmount : fundingSplit(q.mintCost, tradingBalanceBase).depositAmount;
                return (
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
                            background: isUp ? 'var(--up)' : 'var(--down)',
                          }}
                        />
                      </div>
                    </div>

                    <div className="glass-inset mt-3 flex flex-col gap-2 p-3">
                      {feeBps > 0 && (
                        <>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] text-text-3">
                              Skew fee · {(feeBps / 100).toFixed(2)}%
                            </span>
                            <span className="text-[11px] tabular-nums text-text-1">
                              +{feeAmount(feeF)} {sym}
                            </span>
                          </div>
                          <span className="text-[10px] leading-relaxed text-text-3">
                            Bet cost goes to the DeepBook Predict vault; the Skew fee goes to Skew.
                          </span>
                        </>
                      )}
                      {/* What actually leaves the wallet now — reconciles the total
                          cost above with the smaller "coin outflow" the wallet shows,
                          since the manager's free balance funds the rest. */}
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-text-3">Leaves your wallet now</span>
                        <span className="text-[11px] tabular-nums text-text-1">
                          {walletNow > 0n ? '≈ ' : ''}
                          {fmtQuote(fromQuote(walletNow))} {sym}
                        </span>
                      </div>
                      {walletNow > 0n && tradingBalanceBase > 0n ? (
                        <span className="text-[10px] leading-relaxed text-text-3">
                          The rest of the {fmtQuote(cost)} {sym} cost is covered by your{' '}
                          {fmtQuote(fromQuote(tradingBalanceBase))} {sym} free balance in the manager.
                        </span>
                      ) : walletNow === 0n ? (
                        <span className="text-[10px] leading-relaxed text-text-3">
                          Fully covered by your free balance — nothing new is pulled from your wallet.
                        </span>
                      ) : null}
                      <div className="flex items-center justify-between">
                        <span className="text-[11px] text-text-3">Sell now</span>
                        <span className="text-[11px] tabular-nums text-text-2">
                          {fmtQuote(fromQuote(q.redeemPayout))} {sym}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })()
            )}
          </div>

          {/* Near-expiry caution — the failure mode the user just hit. */}
          {closingSoon && !expired && (
            <div className="rounded border border-down/40 bg-down/10 p-2 text-[11px] leading-relaxed text-down">
              Closing in {countdown(oracle.expiry, now)} — a mint may revert if the market settles
              before your transaction lands on-chain.
            </div>
          )}

          <button
            onClick={requestMint}
            disabled={!q || !tradeable || expired || busy === 'mint'}
            className={`group relative flex items-center justify-center gap-2 overflow-hidden rounded-lg border bg-linear-to-b px-3 py-3 text-[13px] font-semibold transition-all disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3 disabled:shadow-none ${
              isUp
                ? 'border-up/50 from-up/25 to-up/10 text-up shadow-[0_0_24px_-6px_var(--accent-glow)] hover:from-up/35 hover:to-up/15 hover:shadow-[0_0_30px_-4px_var(--accent-glow)]'
                : 'border-down/50 from-down/25 to-down/10 text-down shadow-[0_0_24px_-6px_rgba(240,121,107,0.3)] hover:from-down/35 hover:to-down/15 hover:shadow-[0_0_30px_-4px_rgba(240,121,107,0.34)]'
            }`}
          >
            {busy === 'mint' && (
              <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />
            )}
            {busy === 'mint'
              ? 'Confirming in wallet…'
              : expired
                ? 'Market expired'
                : q
                  ? `Mint ${isUp ? 'UP' : 'DOWN'} · pay ${fmtQuote(fromQuote(q.mintCost))} → win ${fmtQuote(contracts)}`
                  : `Mint ${isUp ? 'UP' : 'DOWN'}`}
          </button>

          <p className="text-[10px] leading-relaxed text-text-3">
            The chain confirms the final price when you sign — a transaction can still be rejected
            in your wallet or revert if the market moves or expires first.
          </p>

          {q && (
            <MintConfirmModal
              open={confirmOpen}
              onClose={() => setConfirmOpen(false)}
              onConfirm={handleMint}
              busy={busy === 'mint'}
              headline={`${oracle.underlying_asset} · ${isUp ? 'UP' : 'DOWN'}`}
              tone={isUp ? 'up' : 'down'}
              rows={[
                {
                  label: 'Outcome',
                  value: isUp ? 'Pays if price ends ABOVE' : 'Pays if price ends BELOW',
                },
                { label: 'Strike', value: price(strikeFloat, 0), emphasize: true },
                { label: 'Expiry', value: `${dateUTC(oracle.expiry)} · ${countdown(oracle.expiry, now)}` },
                { label: 'Contracts', value: String(contracts) },
                ...(feeBps > 0
                  ? [{ label: `Skew fee (${(feeBps / 100).toFixed(2)}%)`, value: `${feeAmount(fromQuote(skewFee(q.mintCost, feeBps)))} ${sym}` }]
                  : []),
              ]}
              cost={fmtQuote(fromQuote(q.mintCost))}
              maxWin={fmtQuote(contracts)}
              confirmLabel={`Mint ${isUp ? 'UP' : 'DOWN'}`}
            />
          )}
            </>
          )}
        </div>
      )}

      {managerId && (
        <div className="glass-divider-top flex flex-col gap-2 pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-text-3">Open positions</span>
            <Link href="/portfolio" className="text-[10px] text-text-2 underline hover:text-text-1">
              Portfolio →
            </Link>
          </div>
          {positionsLoading || rangesData.loading ? (
            <span className="text-text-3">loading…</span>
          ) : openPositions.length === 0 && openRanges.length === 0 ? (
            <span className="text-text-3">No open positions — click the surface and mint.</span>
          ) : (
            <>
              {openPositions.slice(0, 3).map((p) => {
                const m = positionMetrics(p);
                return (
                  <div
                    key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                    className={`glass-card interactive flex items-center justify-between py-2 pl-3.5 pr-2 ${
                      p.is_up ? 'up' : 'down'
                    }`}
                  >
                    <div className="flex flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span
                          className={`text-[10px] font-medium uppercase tracking-wider ${
                            p.is_up ? 'text-up' : 'text-down'
                          }`}
                        >
                          {p.is_up ? 'UP' : 'DOWN'}
                        </span>
                        <span className="text-text-1">{price(toFloat(p.strike))}</span>
                      </span>
                      <span className="text-[10px] text-text-3">
                        {fmtQuote(m.contracts)} contracts ·{' '}
                        <span className={m.pnl >= 0 ? 'text-up' : 'text-down'}>
                          {signed(m.pnl)} ({signed(m.pnlPct * 100, 1)}%)
                        </span>
                      </span>
                    </div>
                    <button
                      onClick={() => setRedeeming(p)}
                      disabled={!!busy}
                      className="ctrl-soft rounded-md px-2.5 py-1 text-[11px] text-text-2 disabled:opacity-50"
                    >
                      {m.isSettled ? 'Redeem' : 'Close'}
                    </button>
                  </div>
                );
              })}
              {openRanges.slice(0, 3).map((p) => {
                const rPnl = fromQuote(p.unrealizedPnl);
                return (
                  <div
                    key={`${p.oracleId}-${p.lowerStrike}-${p.higherStrike}`}
                    className="glass-card interactive up flex items-center justify-between py-2 pl-3.5 pr-2"
                  >
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-1.5">
                        <span className="text-[10px] font-medium uppercase tracking-wider text-up">
                          RANGE
                        </span>
                        <span className="truncate text-text-1">
                          {price(toFloat(p.lowerStrike))}–{price(toFloat(p.higherStrike))}
                        </span>
                      </span>
                      <span className="text-[10px] text-text-3">
                        {fmtQuote(fromQuote(p.openQty))} contracts ·{' '}
                        <span className={rPnl >= 0 ? 'text-up' : 'text-down'}>{signed(rPnl)}</span>
                      </span>
                    </div>
                    <button
                      onClick={() => setRedeemingRange(p)}
                      disabled={!!busy}
                      className="ctrl-soft rounded-md px-2.5 py-1 text-[11px] text-text-2 disabled:opacity-50"
                    >
                      {p.settled ? 'Redeem' : 'Close'}
                    </button>
                  </div>
                );
              })}
              {(openPositions.length > 3 || openRanges.length > 3) && (
                <Link
                  href="/portfolio"
                  className="text-[10px] text-text-3 underline hover:text-text-2"
                >
                  view all {openPositions.length + openRanges.length} positions →
                </Link>
              )}
            </>
          )}
        </div>
      )}

      {error && <div className="rounded border border-down/40 bg-down/10 p-2 text-down">{error}</div>}
      {lastDigest && (
        <a
          href={EXPLORER(lastDigest)}
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-text-3 underline hover:text-text-2"
        >
          last tx: {lastDigest.slice(0, 12)}… ↗
        </a>
      )}

      <RedeemModal
        position={redeeming}
        busy={!!busy}
        onConfirm={async (p, quantityBase) => {
          await redeem(p, quantityBase);
          setRedeeming(null);
        }}
        onClose={() => setRedeeming(null)}
      />

      <RangeRedeemModal
        position={redeemingRange}
        busy={!!busy}
        onConfirm={async (p, quantityBase) => {
          await redeemRange({
            oracleId: p.oracleId,
            expiry: p.expiry,
            lowerStrike: BigInt(Math.round(p.lowerStrike)),
            higherStrike: BigInt(Math.round(p.higherStrike)),
            quantity: quantityBase,
          });
          setRedeemingRange(null);
        }}
        onClose={() => setRedeemingRange(null)}
      />
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-text-3">{label}</span>
      <span className="text-text-1">{children}</span>
    </div>
  );
}

function Toggle({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'up' | 'down';
  children: React.ReactNode;
}) {
  const glyph = tone === 'up' ? '▲' : '▼';
  const activeCls =
    tone === 'up'
      ? 'border border-up/50 bg-[var(--accent-soft)] text-up shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_0_22px_-8px_var(--accent-glow)]'
      : 'border border-down/50 bg-[var(--down-soft)] text-down shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06),0_0_22px_-8px_rgba(240,121,107,0.3)]';
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-2.5 text-[13px] font-semibold tracking-wide transition-all ${
        active ? activeCls : 'ctrl-soft text-text-3'
      }`}
    >
      <span className="text-[9px]">{glyph}</span>
      {children}
    </button>
  );
}

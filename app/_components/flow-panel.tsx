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
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { qk } from '@/lib/api/client';
import { predictConfig } from '@/config/predict';
import { toFloat, fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote, price, pct, signed, dateUTC, countdown } from '@/lib/format';
import { useNow } from '@/lib/hooks/use-now';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useLiveOracleData } from '@/lib/hooks/use-live-oracle-data';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { snapStrikeToTick, gridBounds } from '@/lib/keys';
import { quoteMarket, type TradeQuote } from '@/lib/sui/quote';
import { humanizeError } from '@/lib/sui/abort';
import { upFair } from '@/lib/svi/svi';
import { buildMintTx } from '@/lib/sui/predict-tx';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { RedeemModal } from './positions/redeem-modal';
import { positionMetrics } from './positions/position-metrics';
import type { SmileInput } from '@/lib/svi/surface';
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
    managerKeys,
  } = acct;

  const selection = useSurfaceStore((s) => s.selection);
  const pulseFill = useSurfaceStore((s) => s.pulseFill);

  // Active oracle = the clicked one (else soonest expiry).
  const active = useMemo(() => {
    if (selection) {
      const found = inputs.find((i) => i.oracle.oracle_id === selection.oracleId);
      if (found) return found;
    }
    return inputs[0];
  }, [selection, inputs]);

  const [redeeming, setRedeeming] = useState<PositionSummary | null>(null);

  const oracle = active?.oracle;
  const forward = active?.forward ?? 0;
  const grid = useMemo(() => (oracle ? gridBounds(oracle) : null), [oracle]);

  const [strike, setStrike] = useState<bigint>(0n);
  const [isUp, setIsUp] = useState(true);
  const [sizeMode, setSizeMode] = useState<'amount' | 'contracts'>('amount');
  const [amount, setAmount] = useState(1); // DUSDC to spend (amount mode)
  const [contractsInput, setContractsInput] = useState(1); // count (contracts mode)

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

  // The protocol only quotes a spread when the fair price is strictly inside
  // (0,1), and minting requires the ask in [1%,99%]. Far-OTM strikes round to
  // 0%/100% and abort (pricing_config #1). Gate on the client fair price so we
  // never fire a doomed simulate and can explain why.
  const strikeFloat = toFloat(Number(strike));
  const clientUp =
    oracle && strike > 0n ? upFair(strikeFloat, forward, active!.svi, active!.settlement ?? null) : null;
  const tradeable = clientUp != null && clientUp > 0.01 && clientUp < 0.99;

  // Live expiry status — a market at/near expiry will revert on-chain, so we
  // stop quoting and block the mint before the user pays a doomed gas fee.
  const msLeft = oracle ? oracle.expiry - now : 0;
  const expired = !!oracle && msLeft <= 0;
  const closingSoon = !!oracle && msLeft > 0 && msLeft < CLOSING_SOON_MS;

  // Sizing in "amount" mode must divide the target spend by the price the user
  // ACTUALLY pays (the chain ask), not the client SVI fair — the two diverge
  // (esp. near expiry), and sizing off the model is what made a 5 DUSDC target
  // only spend ~2. A 1-contract probe quote gives the authoritative per-unit ask
  // independent of the size we're solving for, so there's no feedback loop.
  const sideFair = clientUp == null ? null : isUp ? clientUp : 1 - clientUp; // bootstrap only
  const unitQuoteQ = useQuery({
    queryKey: ['quote-unit', oracle?.oracle_id, strike.toString(), isUp, owner],
    queryFn: () =>
      quoteMarket(client.core, {
        sender: owner!,
        oracleId: oracle!.oracle_id,
        expiry: oracle!.expiry,
        strike,
        isUp,
        quantity: toQuote(1),
      }),
    enabled: !!owner && !!oracle && strike > 0n && tradeable && !expired && sizeMode === 'amount',
    placeholderData: keepPreviousData,
    refetchInterval: 6000,
    retry: 0,
  });
  // Per-contract ask in DUSDC (cost of exactly 1 contract); fair as a bootstrap.
  const unitAsk = unitQuoteQ.data ? fromQuote(unitQuoteQ.data.mintCost) : sideFair;

  const deriveContracts = (dusdc: number) =>
    unitAsk && unitAsk > 0 ? Math.max(1, Math.round((dusdc / unitAsk) * 100) / 100) : 1;
  const contracts = sizeMode === 'amount' ? deriveContracts(amount) : Math.max(1, contractsInput);
  const qtyBase = toQuote(contracts);

  const switchToAmount = () => {
    setAmount(Math.max(0.01, Math.round(contracts * (unitAsk ?? sideFair ?? 0) * 100) / 100) || 1);
    setSizeMode('amount');
  };
  const switchToContracts = () => {
    setContractsInput(Math.max(1, Math.round(contracts)));
    setSizeMode('contracts');
  };

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
    refetchInterval: 4000,
    retry: 0,
  });
  const q: TradeQuote | undefined = tradeable ? quoteQ.data : undefined;

  const tradingBalance = summary?.trading_balance ?? 0; // @6dec base units

  async function handleMint() {
    if (!managerId || !q || !oracle || expired) return;
    const costBuf = (q.mintCost * 102n) / 100n;
    const depositAmount = costBuf > tradingBalanceBase ? costBuf - tradingBalanceBase : 0n;
    const digest = await runTx(
      'mint',
      buildMintTx({
        managerId,
        oracleId: oracle.oracle_id,
        expiry: oracle.expiry,
        strike,
        isUp,
        quantity: qtyBase,
        depositAmount,
      }),
      [...managerKeys, qk.dusdcBalance(owner ?? '')],
    );
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
  const fromSurface = !!selection && selection.oracleId === oracle.oracle_id;

  return (
    <div className="flex flex-col gap-4 font-mono text-[12px] tabular-nums">
      <div className="flex flex-col gap-1">
        <Row label="Wallet DUSDC">
          {dusdcBalance === undefined ? '…' : fmtQuote(fromQuote(dusdcBalance))}
          {dusdcBalance !== undefined && dusdcBalance < 1_000_000n && predictConfig.faucetUrl && (
            <a href={predictConfig.faucetUrl} target="_blank" rel="noreferrer" className="ml-2 text-up underline">
              get DUSDC
            </a>
          )}
        </Row>
        <Row label="Manager">
          {managerId ? (
            <span className="text-text-2">
              {managerId.slice(0, 10)}…{managerId.slice(-4)}
            </span>
          ) : (
            <button
              onClick={() => createManager()}
              disabled={busy === 'create'}
              className="rounded border border-line-strong px-2 py-0.5 text-up hover:bg-white/5 disabled:opacity-50"
            >
              {busy === 'create' ? 'creating…' : 'Create manager'}
            </button>
          )}
        </Row>
        {managerId && <Row label="Free balance">{fmtQuote(fromQuote(tradingBalance))}</Row>}
      </div>

      {managerId && (
        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-text-3">
              {oracle.underlying_asset} · {dateUTC(oracle.expiry)} ·{' '}
              <span className={expired || closingSoon ? 'text-down' : 'text-text-2'}>
                {expired ? 'expired' : `${countdown(oracle.expiry, now)} left`}
              </span>
            </span>
            {fromSurface && <span className="text-[10px] text-up">↑ from surface</span>}
          </div>

          <div className="flex gap-2">
            <Toggle active={isUp} onClick={() => setIsUp(true)} tone="up">
              UP
            </Toggle>
            <Toggle active={!isUp} onClick={() => setIsUp(false)} tone="down">
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
            <div className="flex items-center gap-2">
              <button onClick={() => stepStrike(-1)} className="px-1.5 text-text-2 hover:text-text-1">
                −
              </button>
              <span className="text-text-1">{price(toFloat(Number(strike)))}</span>
              <button onClick={() => stepStrike(1)} className="px-1.5 text-text-2 hover:text-text-1">
                +
              </button>
            </div>
          </Row>

          {/* Bet size — by DUSDC amount (default) or by contract count */}
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-between">
              <span className="text-text-3">Bet size</span>
              <div className="flex overflow-hidden rounded border border-line">
                <SizeTab active={sizeMode === 'amount'} onClick={switchToAmount}>
                  {predictConfig.quote.symbol}
                </SizeTab>
                <SizeTab active={sizeMode === 'contracts'} onClick={switchToContracts}>
                  Contracts
                </SizeTab>
              </div>
            </div>

            {sizeMode === 'amount' ? (
              <>
                <Row label="Amount to spend">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="number"
                      min={0}
                      step="any"
                      value={amount}
                      onChange={(e) => setAmount(Math.max(0, Number(e.target.value) || 0))}
                      className="w-24 rounded border border-line bg-bg-2 px-2 py-0.5 text-right text-text-1 outline-none focus:border-line-strong"
                    />
                    <span className="text-[10px] text-text-3">{predictConfig.quote.symbol}</span>
                  </div>
                </Row>
                <div className="flex gap-1.5">
                  {[1, 5, 10, 25].map((n) => (
                    <button
                      key={n}
                      onClick={() => setAmount(n)}
                      className={`flex-1 rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${
                        amount === n
                          ? 'border-line-strong text-text-1'
                          : 'border-line text-text-3 hover:text-text-2'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="text-[10px] text-text-3">
                  ≈ {fmtQuote(contracts)} contracts{unitAsk != null && ` @ ${pct(unitAsk, 1)} each`} ·
                  max payout {fmtQuote(contracts)}
                </span>
              </>
            ) : (
              <>
                <Row label="Contracts">
                  <input
                    type="number"
                    min={1}
                    step={1}
                    value={contractsInput}
                    onChange={(e) => setContractsInput(Math.max(1, Number(e.target.value) || 1))}
                    className="w-20 rounded border border-line bg-bg-2 px-2 py-0.5 text-right text-text-1 outline-none focus:border-line-strong"
                  />
                </Row>
                <div className="flex gap-1.5">
                  {[1, 5, 10, 25].map((n) => (
                    <button
                      key={n}
                      onClick={() => setContractsInput(n)}
                      className={`flex-1 rounded border px-1.5 py-0.5 text-[10px] tabular-nums ${
                        contractsInput === n
                          ? 'border-line-strong text-text-1'
                          : 'border-line text-text-3 hover:text-text-2'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                </div>
                <span className="text-[10px] text-text-3">
                  each contract pays 1.00 {predictConfig.quote.symbol} if it wins
                </span>
              </>
            )}
          </div>

          {/* Risk → Reward: the answer to "what do I pay and what can I win?" */}
          <div className="card p-3">
            {expired ? (
              <span className="text-text-3">
                This market has expired and is awaiting settlement — pick another expiry on the
                surface or in the table.
              </span>
            ) : !tradeable ? (
              <span className="text-text-3">
                Strike too far from spot to trade — pick one nearer {price(forward)} (the market
                quotes ~1%–99% only).
              </span>
            ) : quoteQ.isError ? (
              <span className="text-down">{humanizeError(quoteQ.error)}</span>
            ) : !q ? (
              <span className="text-text-3">quoting…</span>
            ) : (
              (() => {
                const cost = fromQuote(q.mintCost);
                const maxPayout = contracts; // each contract pays 1.00 if it wins
                const profit = maxPayout - cost;
                const mult = cost > 0 ? maxPayout / cost : 0;
                const chance = Number((q.mintCost * 1_000_000_000n) / qtyBase) / 1e9;
                return (
                  <div className="flex flex-col">
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex flex-col gap-1">
                        <span className="eyebrow">You pay</span>
                        <span className="text-[19px] leading-none text-text-1">{fmtQuote(cost)}</span>
                      </div>
                      <div className="flex flex-col gap-1">
                        <span className="eyebrow">If you win</span>
                        <span className="flex items-baseline gap-1.5">
                          <span className="text-[19px] leading-none text-up">{fmtQuote(maxPayout)}</span>
                          <span className="rounded bg-up/10 px-1 py-0.5 text-[10px] leading-none text-up">
                            {mult.toFixed(2)}×
                          </span>
                        </span>
                      </div>
                    </div>
                    <span className="mt-1.5 text-[10px] text-text-3">
                      net profit if right <span className="text-up">{signed(profit)}</span>
                    </span>

                    <div className="mt-3 flex flex-col gap-1.5">
                      <div className="flex items-center justify-between">
                        <span className="eyebrow">Market-implied chance</span>
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

                    <div className="mt-3 flex items-center justify-between border-t border-line-soft pt-2.5">
                      <span className="text-[11px] text-text-3">Sell now (redeem)</span>
                      <span className="text-[11px] tabular-nums text-text-2">
                        {fmtQuote(fromQuote(q.redeemPayout))}
                      </span>
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
            onClick={handleMint}
            disabled={!q || !tradeable || expired || busy === 'mint'}
            className="rounded-lg border border-up/40 bg-linear-to-b from-up/20 to-up/5 px-3 py-2.5 text-[13px] font-medium text-up transition-colors hover:from-up/25 hover:to-up/10 disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3"
          >
            {busy === 'mint'
              ? 'minting…'
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
        </div>
      )}

      {managerId && (
        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-text-3">Open positions</span>
            <Link href="/portfolio" className="text-[10px] text-text-2 underline hover:text-text-1">
              Portfolio →
            </Link>
          </div>
          {positionsLoading ? (
            <span className="text-text-3">loading…</span>
          ) : openPositions.length === 0 ? (
            <span className="text-text-3">No open positions — click the surface and mint.</span>
          ) : (
            <>
              {openPositions.slice(0, 3).map((p) => {
                const m = positionMetrics(p);
                return (
                  <div
                    key={`${p.oracle_id}-${p.strike}-${p.is_up}`}
                    className={`card interactive flex items-center justify-between py-2 pl-3.5 pr-2 ${
                      p.is_up ? 'accent-up' : 'accent-down'
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
                      className="rounded border border-line px-2.5 py-1 text-[11px] text-text-2 transition-colors hover:border-line-strong hover:text-text-1 disabled:opacity-50"
                    >
                      {m.isSettled ? 'Redeem' : 'Close'}
                    </button>
                  </div>
                );
              })}
              {openPositions.length > 3 && (
                <Link
                  href="/portfolio"
                  className="text-[10px] text-text-3 underline hover:text-text-2"
                >
                  view all {openPositions.length} positions →
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
        onConfirm={async (p) => {
          await redeem(p);
          setRedeeming(null);
        }}
        onClose={() => setRedeeming(null)}
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

function SizeTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-2 py-0.5 text-[10px] uppercase tracking-wider ${
        active ? 'bg-white/10 text-text-1' : 'text-text-3 hover:text-text-2'
      }`}
    >
      {children}
    </button>
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
  const activeCls =
    tone === 'up'
      ? 'border-up/40 bg-linear-to-b from-up/20 to-up/5 text-up'
      : 'border-down/40 bg-linear-to-b from-down/20 to-down/5 text-down';
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md border px-2 py-1.5 text-[12px] font-medium tracking-wide transition-colors ${
        active ? activeCls : 'border-line text-text-3 hover:border-line-strong hover:text-text-2'
      }`}
    >
      {children}
    </button>
  );
}

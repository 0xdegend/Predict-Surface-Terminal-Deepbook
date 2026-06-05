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
        <div className="flex flex-col gap-2 border-t border-line-soft pt-3">
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
                Strike too far from spot to trade — pick one nearer {price(forward)} (the market
                quotes ~1%–99% only).
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
                const profit = maxPayout - cost;
                const mult = cost > 0 ? maxPayout / cost : 0;
                const chance = Number((q.mintCost * 1_000_000_000n) / qtyBase) / 1e9;
                // Funding split — mint pays from the manager's FREE BALANCE first;
                // only the shortfall (cost+2% buffer − free balance) is pulled from
                // the wallet now. This mirrors `handleMint`'s `depositAmount`, so the
                // figure here matches the "coin outflow" the wallet popup shows.
                const buffered = (q.mintCost * 102n) / 100n;
                const walletNow = buffered > tradingBalanceBase ? buffered - tradingBalanceBase : 0n;
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
            onClick={handleMint}
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

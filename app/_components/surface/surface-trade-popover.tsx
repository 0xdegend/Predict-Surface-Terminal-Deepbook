'use client';

/**
 * SurfaceTradePopover — click-to-mint right on the surface.
 *
 * Clicking a node on the 3-D surface anchors this card at the click point. It
 * opens in a lightweight GLANCE state (strike + UP/DOWN odds + expiry) with a
 * "Preview trade" button; pressing it expands to the TICKET state (size + live
 * chain quote + Mint). Range mode builds a band from two surface clicks.
 *
 * It is a thin consumer of the same engine the right-rail ticket uses — quotes
 * via `quoteMarket`/`quoteRange` (devInspect, chain-authoritative), funding via
 * `fundingSplit`, the PTBs via `usePredictAccount` — so the two never price a
 * trade differently. The rail and this popover stay in sync through the store.
 */
import { useEffect, useRef, useState } from 'react';
import { useCurrentClient } from '@mysten/dapp-kit-react';
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { LuX, LuArrowLeft } from 'react-icons/lu';
import { qk } from '@/lib/api/client';
import { predictConfig } from '@/config/predict';
import { toFloat, fromQuote, toQuote } from '@/config/scale';
import { quote as fmtQuote, price, pct, signed, countdown } from '@/lib/format';
import { useIsEnokiWallet } from '@/lib/hooks/use-is-enoki';
import { usePredictAccount } from '@/lib/hooks/use-predict-account';
import { quoteMarket, quoteRange, type TradeQuote } from '@/lib/sui/quote';
import { fundingSplit, feeRouterPayment, skewFee } from '@/lib/sui/funding';
import { useSkewFee } from '@/lib/hooks/use-skew-fee';
import { humanizeError } from '@/lib/sui/abort';
import { buildMintTx, buildMintWithFeeTx } from '@/lib/sui/predict-tx';
import { upFair, rangeFair } from '@/lib/svi/svi';
import { isTradeableFair, type SmileInput } from '@/lib/svi/surface';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { MintConfirmModal } from '../mint-confirm-modal';

const CLOSING_SOON_MS = 120_000;
const PAD_X = 168; // half popover width + margin (clamp inside the canvas)

export interface PopoverScreen {
  x: number;
  y: number;
  w: number;
  h: number;
}

export function SurfaceTradePopover({
  active,
  now,
  screen,
  onClose,
}: {
  active: SmileInput | null;
  now: number;
  screen: PopoverScreen;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  const ticketMode = useSurfaceStore((s) => s.ticketMode);

  // Escape + outside-click dismissal. A pointerdown on the canvas (to pick a new
  // node) closes this first; onPick then re-opens it at the new spot.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    function onDown(e: PointerEvent) {
      const target = e.target as Element | null;
      if (!target) return;
      // Ignore clicks inside the popover itself.
      if (ref.current?.contains(target)) return;
      // The mint-confirm modal renders in a portal to <body> (outside this
      // subtree) — a click on it must NOT dismiss the popover, or it unmounts
      // the modal mid-confirm and the mint never runs.
      if (target.closest('[role="dialog"], [role="presentation"]')) return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown, true);
    };
  }, [onClose]);

  // Anchor above the click when there's room, else below it. Clamp horizontally
  // so it never spills off the canvas edge.
  const below = screen.y < 280;
  const left = Math.min(Math.max(screen.x, PAD_X), Math.max(screen.w - PAD_X, PAD_X));
  const top = below ? screen.y + 18 : screen.y - 14;
  const translate = below ? 'translate(-50%, 0)' : 'translate(-50%, -100%)';

  return (
    <div
      ref={ref}
      className="popover-in glass pointer-events-auto absolute z-20 w-[19rem] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl shadow-[0_18px_48px_-12px_rgba(0,0,0,0.8)]"
      style={{ left, top, transform: translate }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-2 top-2 z-10 rounded p-1 text-text-3 transition-colors hover:text-text-1"
      >
        <LuX size={13} />
      </button>
      {ticketMode === 'range' ? (
        <RangeBody active={active} now={now} onClose={onClose} />
      ) : (
        <BinaryBody active={active} now={now} onClose={onClose} />
      )}
    </div>
  );
}

/* ─────────────────────────── binary (up / down) ─────────────────────────── */

function BinaryBody({
  active,
  now,
  onClose,
}: {
  active: SmileInput | null;
  now: number;
  onClose: () => void;
}) {
  const client = useCurrentClient();
  const acct = usePredictAccount();
  const isEnoki = useIsEnokiWallet();
  const { feeBps } = useSkewFee();

  const selection = useSurfaceStore((s) => s.selection);
  const select = useSurfaceStore((s) => s.select);
  const setTicketMode = useSurfaceStore((s) => s.setTicketMode);
  const pickRangeStrike = useSurfaceStore((s) => s.pickRangeStrike);
  const pulseFill = useSurfaceStore((s) => s.pulseFill);

  const [view, setView] = useState<'glance' | 'ticket'>('glance');
  const [contracts, setContracts] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const oracle = active?.oracle ?? null;

  // The popover only opens for a binary selection on the active oracle.
  const onActive = !!selection && !!oracle && selection.oracleId === oracle.oracle_id;
  const strike = onActive ? BigInt(selection!.strikeScaled) : 0n;
  const isUp = selection?.isUp ?? true;
  const strikeFloat = toFloat(Number(strike));

  const msLeft = oracle ? oracle.expiry - now : 0;
  const expired = !!oracle && msLeft <= 0;
  const closingSoon = !!oracle && msLeft > 0 && msLeft < CLOSING_SOON_MS;

  const fairUp =
    oracle && onActive ? upFair(strikeFloat, active!.forward, active!.svi, active!.settlement ?? null) : null;
  const tradeable = fairUp != null && isTradeableFair(fairUp);

  const qty = Math.max(1, contracts);
  const qtyBase = toQuote(qty);

  const quoteQ = useQuery({
    queryKey: ['quote', oracle?.oracle_id, strike.toString(), isUp, qtyBase.toString(), acct.owner],
    queryFn: () =>
      quoteMarket(client.core, {
        sender: acct.owner!,
        oracleId: oracle!.oracle_id,
        expiry: oracle!.expiry,
        strike,
        isUp,
        quantity: qtyBase,
      }),
    enabled: view === 'ticket' && !!acct.owner && !!oracle && strike > 0n && tradeable && !expired,
    placeholderData: keepPreviousData,
    refetchInterval: 5000,
    refetchOnWindowFocus: false,
    retry: 0,
  });
  const q: TradeQuote | undefined = tradeable ? quoteQ.data : undefined;

  function setDirection(nextUp: boolean) {
    if (!oracle || strike <= 0n) return;
    select({
      oracleId: oracle.oracle_id,
      expiry: oracle.expiry,
      strikeScaled: strike.toString(),
      strike: strikeFloat,
      isUp: nextUp,
    });
  }

  // Switch this market into the range builder, seeding the just-clicked strike
  // as the first edge — the user clicks one more node to complete the band.
  function switchToRange() {
    if (!oracle || strike <= 0n) return;
    pickRangeStrike({
      oracleId: oracle.oracle_id,
      expiry: oracle.expiry,
      strikeScaled: strike.toString(),
      strike: strikeFloat,
    });
    setTicketMode('range');
  }

  function requestMint() {
    if (!q || !tradeable || expired || acct.busy === 'mint') return;
    if (isEnoki) setConfirmOpen(true);
    else handleMint();
  }

  async function handleMint() {
    if (!acct.managerId || !acct.owner || !q || !oracle || expired) return;
    const tx =
      feeBps > 0
        ? buildMintWithFeeTx({
            managerId: acct.managerId,
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            strike,
            isUp,
            quantity: qtyBase,
            paymentAmount: feeRouterPayment(q.mintCost, acct.tradingBalanceBase, feeBps).paymentAmount,
          })
        : buildMintTx({
            managerId: acct.managerId,
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            strike,
            isUp,
            quantity: qtyBase,
            depositAmount: fundingSplit(q.mintCost, acct.tradingBalanceBase).depositAmount,
          });
    const digest = await acct.runTx('mint', tx, [...acct.managerKeys, qk.dusdcBalance(acct.owner)]);
    setConfirmOpen(false);
    if (digest) {
      pulseFill({ oracleId: oracle.oracle_id, strike: strikeFloat, isUp });
      onClose();
    }
  }

  if (!oracle || !onActive) {
    return <div className="px-3.5 py-3 text-[11px] text-text-3">Loading market…</div>;
  }

  const accent = isUp ? 'up' : 'down';

  return (
    <div className="flex flex-col">
      <PopoverHeader oracle={oracle.underlying_asset} expiry={oracle.expiry} now={now} expired={expired} />

      {/* Up / Down */}
      <div className="flex gap-1.5 px-3 pt-2.5">
        <MiniToggle active={isUp} tone="up" onClick={() => setDirection(true)}>
          ▲ UP
        </MiniToggle>
        <MiniToggle active={!isUp} tone="down" onClick={() => setDirection(false)}>
          ▼ DOWN
        </MiniToggle>
      </div>

      {/* Glance: strike + odds */}
      <div className="flex items-end justify-between px-3.5 pt-3">
        <div className="flex flex-col gap-1">
          <span className="eyebrow">{isUp ? 'Settles above' : 'Settles below'}</span>
          <span className="font-mono text-[20px] leading-none tabular-nums text-text-1">
            {price(strikeFloat)}
          </span>
        </div>
        {fairUp != null && (
          <div className="flex flex-col items-end gap-0.5 font-mono text-[11px] tabular-nums">
            <span className={isUp ? 'text-up' : 'text-text-3'}>UP {pct(fairUp, 1)}</span>
            <span className={!isUp ? 'text-down' : 'text-text-3'}>DN {pct(1 - fairUp, 1)}</span>
          </div>
        )}
      </div>

      {view === 'glance' ? (
        <div className="flex flex-col gap-2 px-3 pb-3 pt-3">
          {!tradeable && (
            <p className="px-0.5 text-[10.5px] leading-snug text-text-3">
              This strike is too far from spot to price — pick one nearer the colored ridge.
            </p>
          )}
          <button
            type="button"
            onClick={() => setView('ticket')}
            disabled={!tradeable || expired}
            className={`rounded-lg border py-2.5 text-[12px] font-semibold transition-all disabled:cursor-not-allowed disabled:border-line disabled:text-text-3 ${
              isUp
                ? 'border-up/50 bg-[var(--accent-soft)] text-up hover:bg-up/15'
                : 'border-down/50 bg-[var(--down-soft)] text-down hover:bg-down/15'
            }`}
          >
            {expired ? 'Market expired' : 'Preview trade →'}
          </button>
          <button
            type="button"
            onClick={switchToRange}
            className="text-[10.5px] text-text-3 underline-offset-2 transition-colors hover:text-text-2"
          >
            or bet a price range instead →
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 px-3 pb-3 pt-3">
          <button
            type="button"
            onClick={() => setView('glance')}
            className="flex items-center gap-1 self-start text-[10.5px] text-text-3 transition-colors hover:text-text-2"
          >
            <LuArrowLeft size={11} /> back
          </button>

          <SizeRow contracts={contracts} setContracts={setContracts} />

          <QuoteCard
            q={q}
            qty={qty}
            qtyBase={qtyBase}
            tradeable={tradeable}
            expired={expired}
            isUp={isUp}
            isError={quoteQ.isError}
            error={quoteQ.error}
            tradingBalanceBase={acct.tradingBalanceBase}
            feeBps={feeBps}
          />

          {closingSoon && !expired && (
            <p className="rounded border border-down/40 bg-down/10 p-2 text-[10.5px] leading-snug text-down">
              Closing in {countdown(oracle.expiry, now)} — a mint may revert if it settles first.
            </p>
          )}

          <MintButton
            label={
              q
                ? `Mint ${isUp ? 'UP' : 'DOWN'} · pay ${fmtQuote(fromQuote(q.mintCost))} → win ${fmtQuote(qty)}`
                : `Mint ${isUp ? 'UP' : 'DOWN'}`
            }
            tone={accent}
            busy={acct.busy === 'mint'}
            disabled={!q || !tradeable || expired || !acct.managerId || acct.busy === 'mint'}
            needsManager={!acct.managerId}
            owner={acct.owner}
            creating={acct.busy === 'create'}
            onCreate={() => acct.createManager()}
            onMint={requestMint}
          />
        </div>
      )}

      {q && (
        <MintConfirmModal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={handleMint}
          busy={acct.busy === 'mint'}
          headline={`${oracle.underlying_asset} · ${isUp ? 'UP' : 'DOWN'}`}
          tone={isUp ? 'up' : 'down'}
          rows={[
            { label: 'Outcome', value: isUp ? 'Pays if price ends ABOVE' : 'Pays if price ends BELOW' },
            { label: 'Strike', value: price(strikeFloat, 0), emphasize: true },
            { label: 'Contracts', value: String(qty) },
            ...(feeBps > 0
              ? [{ label: `Skew fee (${(feeBps / 100).toFixed(2)}%)`, value: `${fmtQuote(fromQuote(skewFee(q.mintCost, feeBps)))} DUSDC` }]
              : []),
          ]}
          cost={fmtQuote(fromQuote(q.mintCost))}
          maxWin={fmtQuote(qty)}
          confirmLabel={`Mint ${isUp ? 'UP' : 'DOWN'}`}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────── range ──────────────────────────────────── */

function RangeBody({
  active,
  now,
  onClose,
}: {
  active: SmileInput | null;
  now: number;
  onClose: () => void;
}) {
  const client = useCurrentClient();
  const acct = usePredictAccount();
  const isEnoki = useIsEnokiWallet();
  const { feeBps } = useSkewFee();

  const band = useSurfaceStore((s) => s.rangeSelection);
  const anchor = useSurfaceStore((s) => s.rangeAnchor);
  const clearRange = useSurfaceStore((s) => s.clearRange);
  const setTicketMode = useSurfaceStore((s) => s.setTicketMode);
  const pulseFill = useSurfaceStore((s) => s.pulseFill);

  const [contracts, setContracts] = useState(1);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const oracle = active?.oracle ?? null;
  const expired = !!oracle && oracle.expiry - now <= 0;

  const hasBand = !!band && !!oracle && band.oracleId === oracle.oracle_id;
  const qty = Math.max(1, contracts);
  const qtyBase = toQuote(qty);
  const fair = hasBand
    ? rangeFair(band!.lower, band!.higher, active!.forward, active!.svi, active!.settlement ?? null)
    : 0;
  const tradeable = hasBand && isTradeableFair(fair);

  const quoteQ = useQuery({
    queryKey: ['range-quote', oracle?.oracle_id, band?.lowerScaled ?? '', band?.higherScaled ?? '', qtyBase.toString(), acct.owner],
    queryFn: () =>
      quoteRange(client.core, {
        sender: acct.owner!,
        oracleId: oracle!.oracle_id,
        expiry: oracle!.expiry,
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

  function requestMint() {
    if (!q || !tradeable || expired || acct.busy === 'mint-range') return;
    if (isEnoki) setConfirmOpen(true);
    else handleMint();
  }

  async function handleMint() {
    if (!q || !band || !oracle || expired) return;
    const digest =
      feeBps > 0
        ? await acct.mintRangeWithFee({
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            lowerStrike: BigInt(band.lowerScaled),
            higherStrike: BigInt(band.higherScaled),
            quantity: qtyBase,
            paymentAmount: feeRouterPayment(q.mintCost, acct.tradingBalanceBase, feeBps).paymentAmount,
          })
        : await acct.mintRange({
            oracleId: oracle.oracle_id,
            expiry: oracle.expiry,
            lowerStrike: BigInt(band.lowerScaled),
            higherStrike: BigInt(band.higherScaled),
            quantity: qtyBase,
            depositAmount: fundingSplit(q.mintCost, acct.tradingBalanceBase).depositAmount,
          });
    setConfirmOpen(false);
    if (digest) {
      pulseFill({ oracleId: oracle.oracle_id, strike: (band.lower + band.higher) / 2, isUp: true });
      onClose();
    }
  }

  if (!oracle) {
    return <div className="px-3.5 py-3 text-[11px] text-text-3">Loading market…</div>;
  }

  return (
    <div className="flex flex-col">
      <PopoverHeader oracle={oracle.underlying_asset} expiry={oracle.expiry} now={now} expired={expired} mode="Range" />

      {!hasBand ? (
        <div className="flex flex-col gap-2 px-3.5 pb-3.5 pt-3">
          <p className="text-[11px] leading-relaxed text-text-2">
            {anchor && anchor.oracleId === oracle.oracle_id
              ? `Lower edge set at ${price(anchor.strike)}. Click another point on the surface to complete the band.`
              : `Click two points on the surface to bet ${oracle.underlying_asset} settles between them.`}
          </p>
          <button
            type="button"
            onClick={() => setTicketMode('binary')}
            className="self-start text-[10.5px] text-text-3 underline-offset-2 transition-colors hover:text-text-2"
          >
            ← back to Up / Down
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5 px-3 pb-3 pt-3">
          <div className="flex items-center justify-between px-0.5">
            <span className="eyebrow">Settles between</span>
            <button
              type="button"
              onClick={clearRange}
              className="ctrl-soft rounded-md px-2 py-0.5 text-[10px] uppercase tracking-wider text-text-3"
            >
              reset
            </button>
          </div>
          <div className="glass-inset flex items-center justify-between px-3 py-2 font-mono text-[13px] tabular-nums text-text-1">
            <span>{price(band!.lower)}</span>
            <span className="text-text-3">—</span>
            <span>{price(band!.higher)}</span>
          </div>

          <SizeRow contracts={contracts} setContracts={setContracts} />

          <QuoteCard
            q={q}
            qty={qty}
            qtyBase={qtyBase}
            tradeable={tradeable}
            expired={expired}
            isUp
            isError={quoteQ.isError}
            error={quoteQ.error}
            tradingBalanceBase={acct.tradingBalanceBase}
            fairFallback={fair}
            feeBps={feeBps}
          />

          <MintButton
            label={q ? `Mint range · pay ${fmtQuote(fromQuote(q.mintCost))} → win ${fmtQuote(qty)}` : 'Mint range'}
            tone="up"
            busy={acct.busy === 'mint-range'}
            disabled={!q || !tradeable || expired || !acct.managerId || acct.busy === 'mint-range'}
            needsManager={!acct.managerId}
            owner={acct.owner}
            creating={acct.busy === 'create'}
            onCreate={() => acct.createManager()}
            onMint={requestMint}
          />
        </div>
      )}

      {q && band && (
        <MintConfirmModal
          open={confirmOpen}
          onClose={() => setConfirmOpen(false)}
          onConfirm={handleMint}
          busy={acct.busy === 'mint-range'}
          headline={`${oracle.underlying_asset} · Range`}
          tone="up"
          rows={[
            { label: 'Outcome', value: 'Pays if price ends in band' },
            { label: 'Band', value: `${price(band.lower)} – ${price(band.higher)}`, emphasize: true },
            { label: 'Contracts', value: String(qty) },
            ...(feeBps > 0
              ? [{ label: `Skew fee (${(feeBps / 100).toFixed(2)}%)`, value: `${fmtQuote(fromQuote(skewFee(q.mintCost, feeBps)))} DUSDC` }]
              : []),
          ]}
          cost={fmtQuote(fromQuote(q.mintCost))}
          maxWin={fmtQuote(qty)}
          confirmLabel="Mint range"
        />
      )}
    </div>
  );
}

/* ───────────────────────────── shared bits ──────────────────────────────── */

function PopoverHeader({
  oracle,
  expiry,
  now,
  expired,
  mode,
}: {
  oracle: string;
  expiry: number;
  now: number;
  expired: boolean;
  mode?: string;
}) {
  return (
    <div className="head-divider flex items-center gap-2 px-3.5 py-2.5 pr-8">
      <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">{oracle}</span>
      {mode && <span className="text-[9px] uppercase tracking-wider text-accent">{mode}</span>}
      <span className={`ml-auto font-mono text-[10px] tabular-nums ${expired ? 'text-down' : 'text-text-3'}`}>
        {expired ? 'expired' : `${countdown(expiry, now)} left`}
      </span>
    </div>
  );
}

function SizeRow({ contracts, setContracts }: { contracts: number; setContracts: (n: number) => void }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-text-3">Contracts</span>
      <div className="ml-auto flex gap-1.5">
        {[1, 5, 10, 25].map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setContracts(n)}
            className={`min-w-7 rounded-md px-2 py-1 text-[11px] tabular-nums transition-colors ${
              contracts === n ? 'border border-up/40 bg-[var(--accent-soft)] text-accent' : 'ctrl-soft text-text-3'
            }`}
          >
            {n}
          </button>
        ))}
      </div>
    </div>
  );
}

function QuoteCard({
  q,
  qty,
  qtyBase,
  tradeable,
  expired,
  isUp,
  isError,
  error,
  tradingBalanceBase,
  fairFallback,
  feeBps,
}: {
  q: TradeQuote | undefined;
  qty: number;
  qtyBase: bigint;
  tradeable: boolean;
  expired: boolean;
  isUp: boolean;
  isError: boolean;
  error: unknown;
  tradingBalanceBase: bigint;
  fairFallback?: number;
  feeBps: number;
}) {
  const sym = predictConfig.quote.symbol;
  const glow = q && tradeable && !expired ? (isUp ? 'up glow-accent' : 'down glow-down') : '';

  let body: React.ReactNode;
  if (expired) {
    body = <span className="text-text-3">This market has expired — pick another expiry.</span>;
  } else if (!tradeable) {
    body = <span className="text-text-3">Too far from spot to price — pick a strike nearer the colored ridge.</span>;
  } else if (!q) {
    body = isError ? (
      <span className="text-down">{humanizeError(error)}</span>
    ) : (
      <span className="text-text-3">quoting…</span>
    );
  } else {
    const cost = fromQuote(q.mintCost);
    const maxPayout = qty;
    const feeF = fromQuote(skewFee(q.mintCost, feeBps));
    const profit = maxPayout - cost - feeF; // net of the Skew fee too
    const mult = cost + feeF > 0 ? maxPayout / (cost + feeF) : 0;
    const chance =
      fairFallback != null && q == null ? fairFallback : Number((q.mintCost * 1_000_000_000n) / qtyBase) / 1e9;
    const walletNow =
      feeBps > 0
        ? feeRouterPayment(q.mintCost, tradingBalanceBase, feeBps).paymentAmount
        : fundingSplit(q.mintCost, tradingBalanceBase).depositAmount;
    body = (
      <div className="flex flex-col">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <span className="eyebrow">You pay</span>
            <span className="flex items-baseline gap-1">
              <span className="font-mono text-[19px] leading-none tabular-nums text-text-1">{fmtQuote(cost)}</span>
              <span className="text-[10px] text-text-3">{sym}</span>
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="eyebrow">You win</span>
            <span className="flex items-baseline gap-1">
              <span className="font-mono text-[19px] leading-none tabular-nums text-up">{fmtQuote(maxPayout)}</span>
              <span className="rounded bg-[var(--accent-soft)] px-1 py-0.5 text-[9px] leading-none text-up">
                {mult.toFixed(2)}×
              </span>
            </span>
          </div>
        </div>
        <span className="mt-1.5 text-[10px] text-text-3">
          net if right <span className="text-up">{signed(profit)}</span> · implied {pct(chance, 1)}
        </span>
        <div className="hairline-fade mt-2.5" />
        {feeBps > 0 && (
          <div className="mt-2.5 flex items-center justify-between">
            <span className="text-[10px] text-text-3">Skew fee · {(feeBps / 100).toFixed(2)}%</span>
            <span className="font-mono text-[10px] tabular-nums text-text-1">+{fmtQuote(feeF)} {sym}</span>
          </div>
        )}
        <div className="mt-2.5 flex items-center justify-between">
          <span className="text-[10px] text-text-3">Leaves your wallet now</span>
          <span className="font-mono text-[10px] tabular-nums text-text-1">
            {walletNow > 0n ? '≈ ' : ''}
            {fmtQuote(fromQuote(walletNow))} {sym}
          </span>
        </div>
        {feeBps > 0 && (
          <span className="mt-1.5 text-[9.5px] leading-snug text-text-3">
            Bet cost → DeepBook Predict vault · Skew fee → Skew
          </span>
        )}
      </div>
    );
  }

  return <div className={`glass-card p-3 font-mono text-[11px] tabular-nums ${glow}`}>{body}</div>;
}

function MintButton({
  label,
  tone,
  busy,
  disabled,
  needsManager,
  owner,
  creating,
  onCreate,
  onMint,
}: {
  label: string;
  tone: 'up' | 'down';
  busy: boolean;
  disabled: boolean;
  needsManager: boolean;
  owner: string | null;
  creating: boolean;
  onCreate: () => void;
  onMint: () => void;
}) {
  if (!owner) {
    return (
      <div className="glass-inset rounded-lg py-2.5 text-center text-[11px] text-text-3">
        Connect a wallet (top-right) to trade
      </div>
    );
  }
  if (needsManager) {
    return (
      <button
        type="button"
        onClick={onCreate}
        disabled={creating}
        className="rounded-lg border border-up/40 bg-[var(--accent-soft)] py-2.5 text-[12px] font-semibold text-accent transition-colors hover:bg-up/15 disabled:opacity-50"
      >
        {creating ? 'creating account…' : 'Create trading account first'}
      </button>
    );
  }
  const toneCls =
    tone === 'up'
      ? 'border-up/50 from-up/25 to-up/10 text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:from-up/35'
      : 'border-down/50 from-down/25 to-down/10 text-down shadow-[0_0_22px_-8px_rgba(240,121,107,0.3)] hover:from-down/35';
  return (
    <button
      type="button"
      onClick={onMint}
      disabled={disabled}
      className={`flex items-center justify-center gap-2 rounded-lg border bg-linear-to-b px-3 py-2.5 text-[12px] font-semibold transition-all disabled:cursor-not-allowed disabled:border-line disabled:from-transparent disabled:to-transparent disabled:text-text-3 disabled:shadow-none ${toneCls}`}
    >
      {busy && <span className="h-3.5 w-3.5 animate-spin rounded-full border-[1.5px] border-current border-t-transparent" />}
      {busy ? 'Confirming in wallet…' : label}
    </button>
  );
}

function MiniToggle({
  active,
  tone,
  onClick,
  children,
}: {
  active: boolean;
  tone: 'up' | 'down';
  onClick: () => void;
  children: React.ReactNode;
}) {
  const activeCls =
    tone === 'up'
      ? 'border border-up/50 bg-[var(--accent-soft)] text-up'
      : 'border border-down/50 bg-[var(--down-soft)] text-down';
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-lg py-2 text-[12px] font-semibold tracking-wide transition-all ${
        active ? activeCls : 'ctrl-soft text-text-3'
      }`}
    >
      {children}
    </button>
  );
}

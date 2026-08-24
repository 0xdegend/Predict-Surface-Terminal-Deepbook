'use client';

/**
 * V2PositionsPanel — the connected account's open positions in the trade rail,
 * at full styling parity with the legacy OpenPositions (positions/open-positions):
 * an "Open positions" eyebrow + Portfolio link, then compact directional
 * glass-cards (UP / DOWN / RANGE pill, strike/band, "N to win · PnL") each with a
 * one-tap Close / Redeem / Clear that opens the same confirmation dialog as the
 * full Portfolio (win/loss preview + partial close). Capped at 3 — the rest are
 * one tap away under Portfolio.
 *
 * Reads the SAME enriched rows as the Portfolio (useV2PortfolioPositions), so the
 * rail and the full grid can never disagree, and TanStack dedupes the fetches.
 */
import { useState } from 'react';
import { GlassError } from '../ui/glass-error';
import Link from 'next/link';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useMounted } from '@/lib/hooks/use-mounted';
import { useNow } from '@/lib/hooks/use-now';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { predictV2Config } from '@/config/predict';
import { quote as fmtQuote, price, signed } from '@/lib/format';
import { V2RedeemModal } from './redeem-modal';
import { useClaimCelebration } from './use-claim-celebration';
import { winningClaimPayout, positionWinPayout, settledClaimState, type V2PortfolioPosition } from '@/lib/portfolio/v2';
import { retireRootIfDone } from '@/lib/portfolio/retire-root';

/** Max position cards shown in the rail before deferring to Portfolio. */
const MAX_SHOWN = 3;

/**
 * `liveOnly` hides SETTLED rows and shows only live, in-play bets. The keeper auto-redeems
 * settled winners within seconds ([[keeper-redeem-read-gap]]), so during the brief window
 * before that redeem is folded in, an already-paid winner can linger here as a stale
 * "Claim" row. The trade rail / Portfolio keep settled rows on purpose (a stalled keeper
 * needs a manual claim), but the co-pilot "open positions" watch-list wants live bets only.
 */
export function V2PositionsPanel({ liveOnly = false }: { liveOnly?: boolean }) {
  const acct = usePredictAccountV2();
  // SSR has no wallet but the client restores one synchronously — branch on the
  // owner only after mount so the server and first client paint match.
  const mounted = useMounted();
  // Live clock (seed 0 → real time right after mount) for the keeper-grace check that
  // decides whether a settled win still shows a manual claim.
  const now = useNow(0);
  const { positions, isLoading } = useV2PortfolioPositions(acct.accountId, acct.owner);
  const [redeeming, setRedeeming] = useState<V2PortfolioPosition | null>(null);
  const { celebrate, overlay: claimCelebration } = useClaimCelebration();

  const sym = predictV2Config.quote.symbol;
  const open = positions.filter((p) => p.qty > 0 && (!liveOnly || !p.settled));
  const shown = open.slice(0, MAX_SHOWN);

  // Confirmed from the dialog with the chosen partial amount (base units).
  async function handleConfirm(p: V2PortfolioPosition, closeQuantity: bigint) {
    if (p.sample || !p.marketId || p.orderId == null || closeQuantity <= 0n) {
      setRedeeming(null);
      return;
    }
    const args = { marketId: p.marketId, orderId: p.orderId, closeQuantity };
    // Settled winner → celebrate (SuccessModal + confetti); everything else toasts.
    const payout = winningClaimPayout(p, closeQuantity);
    const digest = p.settled
      ? await acct.redeemSettled(args, payout != null ? { silentSuccess: true } : undefined)
      : await acct.redeemLive(args);
    if (digest) {
      setRedeeming(null);
      if (payout != null) celebrate(payout, digest);
    }
    // Same rule as the portfolio: a landed full close OR a chain refusal ("nothing left
    // to close") retires the row for good. See retire-root.
    if (
      retireRootIfDone(
        { digest, fullClose: closeQuantity >= (p.qtyBase ?? 0n), lastError: acct.lastError() },
        p.positionRootId ?? (p.orderId != null ? String(p.orderId) : ''),
        acct.owner || acct.accountId || '',
      ) &&
      !digest
    ) {
      setRedeeming(null);
      acct.clearError();
    }
  }

  return (
    // `font-mono tabular-nums` renders the prices/PnL in the terminal's monospace
    // figures. No self-border — the trade-screen wrapper owns the rail divider.
    <div className="flex flex-col gap-2 font-mono text-[12px] tabular-nums">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider text-text-3">Open positions</span>
        <Link href="/v2/portfolio" className="text-[10px] text-text-2 underline hover:text-text-1">
          Portfolio →
        </Link>
      </div>

      {!mounted || !acct.owner ? (
        <span className="text-text-2">Connect your wallet to see your positions.</span>
      ) : isLoading ? (
        <span className="text-text-3">loading…</span>
      ) : open.length === 0 ? (
        <span className="text-text-2">No open positions yet. Place one from the active markets above.</span>
      ) : (
        <>
          {shown.map((p) => (
            <PositionRow key={p.key} p={p} sym={sym} now={now} busy={!!acct.busy} onClose={() => setRedeeming(p)} />
          ))}
          {open.length > MAX_SHOWN && (
            <Link href="/v2/portfolio" className="text-[10px] text-text-3 underline hover:text-text-2">
              view all {open.length} positions →
            </Link>
          )}
        </>
      )}

      {acct.error && <GlassError message={acct.error} onDismiss={acct.clearError} />}

      <V2RedeemModal
        position={redeeming}
        busy={!!acct.busy}
        onConfirm={handleConfirm}
        onClose={() => setRedeeming(null)}
      />

      {claimCelebration}
    </div>
  );
}

/** One compact position card — mirrors the legacy OpenPositions row exactly. */
function PositionRow({
  p,
  sym,
  now,
  busy,
  onClose,
}: {
  p: V2PortfolioPosition;
  sym: string;
  now: number;
  busy: boolean;
  onClose: () => void;
}) {
  const isRange = p.direction === 'Range';
  const up = p.direction !== 'Down';
  // Range + winning binaries carry the green tint; a losing binary carries coral.
  const tone = isRange || up ? 'up' : 'down';
  const dirLabel = isRange ? 'RANGE' : up ? 'UP' : 'DOWN';

  // The keeper auto-redeems settled positions, so a settled row is either paying out on
  // its own (no action), a keeper that's clearly late (offer a fallback claim), or a loss
  // being auto-cleared. A live row still closes normally.
  const claim = settledClaimState(p, now);

  const hasPnl = p.pnl != null;
  const pnlPct = p.cost && p.cost > 0 ? (p.pnl ?? 0) / p.cost : 0;

  return (
    <div className={`glass-card interactive flex items-center justify-between py-2 pl-3.5 pr-2 ${tone}`}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="flex items-center gap-1.5">
          <span className={`text-[10px] font-medium uppercase tracking-wider ${up ? 'text-up' : 'text-down'}`}>
            {dirLabel}
          </span>
          <span className="truncate text-text-1">
            {isRange
              ? p.band
                ? `${price(p.band.lower)}–${price(p.band.higher)}`
                : '—'
              : p.strike != null
                ? price(p.strike)
                : '—'}
          </span>
        </span>
        <span className="text-[10px] text-text-3">
          {claim === 'auto_paying' || claim === 'claim_fallback'
            ? `${fmtQuote(positionWinPayout(p))} ${sym} won`
            : `${fmtQuote(positionWinPayout(p))} ${sym} to win`}
          {hasPnl && (
            <>
              {' '}·{' '}
              <span className={(p.pnl ?? 0) >= 0 ? 'text-up' : 'text-down'}>
                {signed(p.pnl ?? 0)}
                {!isRange && ` (${signed(pnlPct * 100, 1)}%)`}
              </span>
            </>
          )}
        </span>
      </div>
      {/* Auto-paying win → a quiet "paying out" note, no button (the keeper pays it).
          Auto-clearing loss → "Lost", no button. A live close, a keeper-late fallback
          claim (win), or a keeper-late fallback clear (loss) each gets an action. */}
      {claim === 'auto_paying' ? (
        <span className="shrink-0 px-2.5 py-1 text-[10px] text-up/80">Paying out…</span>
      ) : claim === 'auto_clearing' ? (
        <span className="shrink-0 px-2.5 py-1 text-[10px] text-text-3">Lost</span>
      ) : (
        <button
          onClick={onClose}
          disabled={busy || p.sample}
          title={claim === 'clear_fallback' ? 'The automatic clear is late. Clear this settled position yourself' : undefined}
          className="shrink-0 ctrl-soft rounded-md px-2.5 py-1 text-[11px] text-text-2 disabled:opacity-50"
        >
          {claim === 'claim_fallback' ? 'Claim' : claim === 'clear_fallback' ? 'Clear' : 'Close'}
        </button>
      )}
    </div>
  );
}

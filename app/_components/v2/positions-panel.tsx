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
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import { predictV2Config } from '@/config/predict';
import { quote as fmtQuote, price, signed } from '@/lib/format';
import { V2RedeemModal } from './redeem-modal';
import { useClaimCelebration } from './use-claim-celebration';
import { winningClaimPayout, positionWinPayout, type V2PortfolioPosition } from '@/lib/portfolio/v2';

/** Max position cards shown in the rail before deferring to Portfolio. */
const MAX_SHOWN = 3;

export function V2PositionsPanel() {
  const acct = usePredictAccountV2();
  // SSR has no wallet but the client restores one synchronously — branch on the
  // owner only after mount so the server and first client paint match.
  const mounted = useMounted();
  const { positions, isLoading } = useV2PortfolioPositions(acct.accountId, acct.owner);
  const [redeeming, setRedeeming] = useState<V2PortfolioPosition | null>(null);
  const { celebrate, overlay: claimCelebration } = useClaimCelebration();

  const sym = predictV2Config.quote.symbol;
  const open = positions.filter((p) => p.qty > 0);
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
        <span className="text-text-2">No open positions yet — pick a market above and place your first bet.</span>
      ) : (
        <>
          {shown.map((p) => (
            <PositionRow key={p.key} p={p} sym={sym} busy={!!acct.busy} onClose={() => setRedeeming(p)} />
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
  busy,
  onClose,
}: {
  p: V2PortfolioPosition;
  sym: string;
  busy: boolean;
  onClose: () => void;
}) {
  const isRange = p.direction === 'Range';
  const up = p.direction !== 'Down';
  // Range + winning binaries carry the green tint; a losing binary carries coral.
  const tone = isRange || up ? 'up' : 'down';
  const dirLabel = isRange ? 'RANGE' : up ? 'UP' : 'DOWN';

  // Settled against the bet → marks to 0, nothing to redeem, so "Clear" it.
  const worthless = p.settled && (p.won === false || (p.markValue != null && p.markValue <= 0));
  const label = worthless ? 'Clear' : p.settled ? 'Redeem' : 'Close';

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
          {fmtQuote(positionWinPayout(p))} {sym} to win
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
      <button
        onClick={onClose}
        disabled={busy || p.sample}
        className="ctrl-soft rounded-md px-2.5 py-1 text-[11px] text-text-2 disabled:opacity-50"
      >
        {label}
      </button>
    </div>
  );
}

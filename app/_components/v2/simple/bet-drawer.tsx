'use client';

/**
 * SimpleBetDrawer — the mobile bet step. On a phone the call is made ON the chart (and
 * on any round card), and this slides up to ask the one remaining question: how much.
 *
 * WHY a drawer rather than the desktop ticket stacked below: on mobile the ticket sat
 * under a full-height chart, so choosing a direction meant scrolling away from the very
 * price you were reading. Putting UP/DOWN on the chart and bringing the amount to the
 * thumb keeps the decision and the evidence on screen together.
 *
 * It re-quotes against the amount as it's typed, so the payout shown is the payout for
 * the number in the box. The LINE, though, arrives with the intent and is never re-derived
 * here — see `BetIntent`. Placing hands straight back to the screen's one confirm/mint
 * funnel (the sheet closes first, so the review modal is never stacked on top of it).
 *
 * Mirrors V2TradeSheet's sheet mechanics — backdrop, grab handle, Esc, body-scroll lock,
 * safe-area padding, z-44/45 — and raises the shared mobile-sheet flag so the floating
 * dock (fixed, z-50) tucks away instead of covering the confirm button.
 */
import { useEffect } from 'react';
import { LuX, LuArrowUp, LuArrowDown } from 'react-icons/lu';
import { useV2Pricer } from '@/lib/hooks/use-v2-pricer';
import { useMobileSheetStore } from '@/lib/store/mobile-sheet-store';
import { quoteSide } from '@/lib/sui/v2/simple-round';
import { toFloat } from '@/config/scale';
import { cadenceOf, isTooCloseToExpiry } from '@/lib/markets/v2-discovery';
import { CADENCE_META } from './cadence';
import { sanitizeAmount } from './amount';
import { price } from '@/lib/format';
import { fromQuote } from '@/config/scale';
import type { RoundPick } from './round-cards';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

/**
 * The call being placed. It carries the LINE the trader actually saw, rather than letting
 * the drawer work one out for itself — an unpinned round's line is chosen and then held,
 * so a second, independently-held copy drifts from the first and the sheet ends up
 * offering a bet against a different number than the chart is drawing.
 */
export type BetIntent = { market: V2Market; isUp: boolean; lineScaled: bigint };

export function SimpleBetDrawer({
  intent,
  open,
  onClose,
  stakeText,
  setStakeText,
  presets,
  spendable,
  now,
  pricerSeeds,
  onPlace,
  busy,
  connected,
  needsAccount,
}: {
  /** Kept populated while the sheet slides out, so content doesn't vanish mid-animation. */
  intent: BetIntent | null;
  open: boolean;
  onClose: () => void;
  stakeText: string;
  setStakeText: (v: string) => void;
  presets: number[];
  spendable: bigint;
  now: number;
  pricerSeeds: Record<string, LivePricer>;
  onPlace: (pick: RoundPick) => void;
  busy: boolean;
  connected: boolean;
  /** No trading account yet — the first tap creates one. */
  needsAccount: boolean;
}) {
  const market = intent?.market ?? null;
  const isUp = intent?.isUp ?? true;
  const stake = Number(stakeText) || 0;

  // Only the PRICER is re-read here; the line came in with the intent. Quoting is pure,
  // so the payout tracks the amount as it's typed without a second source of truth.
  const pricerQ = useV2Pricer(
    market?.expiry_market_id ?? null,
    market ? pricerSeeds[market.expiry_market_id] : undefined,
  );
  const pricer = pricerQ.data ?? null;
  const line = intent ? toFloat(intent.lineScaled) : null;
  const q = market && pricer && intent ? quoteSide(market, pricer, intent.lineScaled, stake, isUp) : null;

  // Tuck the floating dock away while the sheet is up — it is fixed at z-50 and was
  // painting over the sheet's confirm button. Cleared on unmount too, so the dock can
  // never be stranded off-screen by a sheet that went away without closing.
  const setSheetOpen = useMobileSheetStore((s) => s.setSheetOpen);
  useEffect(() => {
    setSheetOpen(open);
    return () => setSheetOpen(false);
  }, [open, setSheetOpen]);

  // Esc closes; lock the page behind the sheet while it's open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const closing = !!market && isTooCloseToExpiry(market, now);
  const ready = !!market && !!q && q.quotable && line != null;
  const canPlace = ready && connected && !busy && !closing;
  const Arrow = isUp ? LuArrowUp : LuArrowDown;
  const tone = isUp ? 'text-up' : 'text-down';
  const cadenceLabel = market ? CADENCE_META[cadenceOf(market)].short : '';

  return (
    <>
      <div
        aria-hidden
        onClick={onClose}
        className={`fixed inset-0 z-44 bg-black/55 transition-opacity duration-300 lg:hidden ${
          open ? 'opacity-100' : 'pointer-events-none opacity-0'
        }`}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Place your bet"
        className={`glass fixed inset-x-0 bottom-0 z-45 flex max-h-[88dvh] flex-col rounded-t-2xl border-t border-white/10 shadow-[0_-18px_48px_-12px_rgba(0,0,0,0.8)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] lg:hidden ${
          open ? 'translate-y-0' : 'pointer-events-none translate-y-full'
        }`}
      >
        <div className="relative flex shrink-0 items-center justify-center px-4 pb-2 pt-3">
          <span aria-hidden className="h-1 w-9 rounded-full bg-white/20" />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="absolute right-2 top-1.5 z-30 rounded-md p-2 text-text-3 transition-colors hover:text-text-1"
          >
            <LuX size={18} />
          </button>
        </div>

        <div className="scroll-quiet min-h-0 overflow-y-auto overscroll-contain px-4 pb-[calc(env(safe-area-inset-bottom)+1.25rem)] pt-1">
          {/* The call being made, restated — the sheet covers the chart, so it has to
              carry which way and against what line on its own. */}
          <div className={`glass-side ${isUp ? 'up' : 'down'} mb-4 flex items-center justify-between gap-3 px-3.5 py-3`}>
            <span className={`flex items-center gap-2 text-[15px] font-bold ${tone}`}>
              <Arrow size={17} />
              {isUp ? 'UP' : 'DOWN'}
            </span>
            <span className="flex flex-col items-end gap-0.5 leading-none">
              <span className="text-[10px] uppercase tracking-wider text-text-3">
                {cadenceLabel} · closes {isUp ? 'above' : 'below'}
              </span>
              <span className="font-mono text-[15px] font-semibold tabular-nums text-text-1">
                {line == null ? '—' : price(line)}
              </span>
            </span>
          </div>

          <div className="mb-3 flex items-center justify-between">
            <span className="eyebrow">Bet amount</span>
            <span className="text-[11px] text-text-3">
              Wallet balance <span className="font-mono tabular-nums">${price(fromQuote(spendable))}</span>
            </span>
          </div>
          <div className="mb-2 flex gap-1.5">
            {presets.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setStakeText(String(p))}
                className={`flex-1 rounded-lg border py-2.5 font-mono text-[13px] font-semibold transition-colors ${
                  stake === p
                    ? 'border-(--accent-line) bg-(--accent-soft) text-text-1'
                    : 'border-(--line-soft) bg-bg-2 text-text-2'
                }`}
              >
                ${p}
              </button>
            ))}
          </div>
          {/* 16px so iOS doesn't zoom the page on focus. */}
          <input
            type="text"
            inputMode="decimal"
            value={stakeText}
            onChange={(e) => setStakeText(sanitizeAmount(e.target.value))}
            placeholder="0"
            aria-label="Bet amount"
            className="mb-3 w-full rounded-lg border border-(--line-soft) bg-bg-2 px-3 py-2.5 text-center font-mono text-[16px] text-text-1 outline-none focus:border-(--line-strong)"
          />

          <div className="mb-4 flex items-center justify-between rounded-lg border border-(--line-soft) bg-bg-2/40 px-3 py-2.5">
            <span className={`text-[10.5px] font-semibold uppercase tracking-wider ${tone}`}>
              {isUp ? 'Up' : 'Down'} wins
            </span>
            <span className="font-mono text-[15px] font-semibold tabular-nums text-text-1">
              {q && q.quotable ? `$${price(fromQuote(q.winBase))}` : '—'}
            </span>
          </div>

          <button
            type="button"
            disabled={!canPlace}
            onClick={() => market && q && intent && line != null && onPlace({ market, line, lineScaled: intent.lineScaled, quote: q, isUp })}
            className={`glass-side ${isUp ? 'up' : 'down'} flex w-full items-center justify-center gap-2 px-4 py-3.5 text-[15px] font-bold ${tone}`}
          >
            <Arrow size={17} />
            {needsAccount ? 'Set up my account' : `Bet ${isUp ? 'UP' : 'DOWN'} · $${stakeText || '0'}`}
          </button>

          <p className="mt-2.5 text-center text-[11px] text-text-3">
            {!connected
              ? 'Connect your wallet (top right) to place a bet.'
              : closing
                ? 'This round is closing — the next one opens in a moment.'
                : ready
                  ? ''
                  : 'Working out the price…'}
          </p>
        </div>
      </div>
    </>
  );
}

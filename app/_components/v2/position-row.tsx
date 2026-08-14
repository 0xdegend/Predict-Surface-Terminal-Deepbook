'use client';

/**
 * V2PositionRow — the COMPACT form of a v2 position, the dense counterpart to the
 * full V2PositionCard. Once you hold several bets (and especially several settled
 * winners waiting to be claimed) the big cards eat the page; this collapses each
 * to a single scannable line — direction · market · state · value · PnL — while
 * keeping every action the card has (Share, market link, and the state's primary
 * button: Close / Claim / Clear, or a disabled Awaiting while settling).
 *
 * Same state model as the card (live / settling / won / lost) so a position reads
 * identically in either view; the portfolio toggles between them.
 */
import { useState } from 'react';
import {
  LuArrowUp,
  LuArrowDown,
  LuCalendarRange,
  LuDownload,
  LuCircleX,
  LuClock,
  LuExternalLink,
  LuShare,
} from 'react-icons/lu';
import { quote as fmtQuote, price, signed, dateUTC, countdown } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { ShareCardModal } from '@/app/_components/positions/share-card-modal';
import type { ShareCardData } from '@/app/_components/positions/share-card-canvas';
import { positionWinPayout, settledClaimState, type SettledClaimState, type V2PortfolioPosition } from '@/lib/portfolio/v2';

const OBJECT_EXPLORER = (id: string) => `https://suiscan.xyz/${predictV2Config.network}/object/${id}`;

type Result = 'live' | 'settling' | 'won' | 'lost';

export function V2PositionRow({
  position: p,
  now,
  busy,
  onRedeem,
}: {
  position: V2PortfolioPosition;
  now: number;
  busy: boolean;
  onRedeem: (p: V2PortfolioPosition) => void;
}) {
  const [shareOpen, setShareOpen] = useState(false);
  const sym = predictV2Config.quote.symbol;
  const isRange = p.direction === 'Range';
  const up = p.direction !== 'Down';
  const remaining = p.expiry != null ? p.expiry - now : null;
  const expired = remaining != null && remaining <= 0;

  const settling = !p.settled && expired;
  const won = p.settled ? (p.won ?? (p.pnl ?? 0) >= 0) : null;
  const result: Result = p.settled ? (won ? 'won' : 'lost') : settling ? 'settling' : 'live';
  const decided = p.settled;
  const positive = (p.pnl ?? 0) >= 0;
  const isClaim = decided && won === true;
  const worthless = decided && won === false;
  // The keeper auto-redeems settled rows: a win is "paying out" (or a keeper-late fallback
  // claim), a loss is auto-cleared. null while live/settling → the normal close/awaiting.
  const claim = settledClaimState(p, now);

  const title = p.underlying ?? 'BTC';
  const condition =
    isRange && p.band
      ? `${price(p.band.lower)} — ${price(p.band.higher)}`
      : p.strike != null
        ? `${title} ${up ? '≥' : '≤'} ${price(p.strike)}`
        : title;

  // Value column: settled winners show the payout; live shows current value.
  const value = isClaim ? (p.markValue ?? positionWinPayout(p)) : worthless ? 0 : (p.markValue ?? null);

  const shareData: ShareCardData = {
    underlying: title,
    up,
    strike: p.strike ?? 0,
    expiry: p.expiry ?? 0,
    result: result === 'settling' ? 'live' : result,
    decided,
    pnl: p.pnl ?? 0,
    pnlPct: p.pnl != null && p.cost ? p.pnl / p.cost : 0,
    cost: p.cost ?? 0,
    contracts: p.qty,
    entryPrice: p.entryPrice ?? 0,
    markPrice: p.markPrice ?? null,
    spark: p.spark ?? [],
    band: p.band,
    leverage: p.leverage,
  };

  const orbColor = up ? 'border-up/45 text-up' : 'border-down/45 text-down';

  return (
    <div className="glass-inset flex flex-wrap items-center gap-x-4 gap-y-2.5 p-3 font-mono text-[12px] tabular-nums">
      {/* market + state */}
      <div className="flex min-w-0 flex-1 basis-56 items-center gap-3">
        <span className={`inline-flex h-8 w-8 flex-none items-center justify-center rounded-full border ${orbColor}`} aria-hidden>
          {isRange ? <LuCalendarRange size={15} /> : up ? <LuArrowUp size={16} /> : <LuArrowDown size={16} />}
        </span>
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="flex items-center gap-2 truncate text-[13px] leading-none text-text-1">
            {condition}
            <StateChip result={result} isRange={isRange} />
          </span>
          <span className="truncate font-sans text-[11px] text-text-3">
            {p.expiry != null ? dateUTC(p.expiry, false) : '—'} · {fmtQuote(p.qty)} contracts
            {result === 'live' && remaining != null ? ` · ${countdown(p.expiry!, now)} left` : ''}
          </span>
        </div>
      </div>

      {/* value */}
      <div className="flex w-24 flex-none flex-col items-end gap-0.5">
        <span className="text-[9px] uppercase tracking-wider text-text-3">
          {decided ? (won ? 'Payout' : 'Final') : 'Value'}
        </span>
        <span className="text-[13px] leading-none text-text-1">
          {value != null ? fmtQuote(value) : '—'} <span className="text-[9px] text-text-3">{sym}</span>
        </span>
      </div>

      {/* pnl */}
      <div className="flex w-20 flex-none flex-col items-end gap-0.5">
        <span className="text-[9px] uppercase tracking-wider text-text-3">{decided ? 'Realized' : 'PnL'}</span>
        <span className={`text-[13px] leading-none ${positive ? 'text-up' : 'text-down'}`}>
          {p.pnl != null ? signed(p.pnl) : '—'}
          {p.pnl != null && p.cost ? (
            <span className="ml-1 text-[10px] opacity-80">{signed((p.pnl / p.cost) * 100, 0)}%</span>
          ) : null}
        </span>
      </div>

      {/* actions */}
      <div className="ml-auto flex flex-none items-center gap-1.5">
        <button
          onClick={() => setShareOpen(true)}
          aria-label="Share position as image"
          className="ctrl-soft inline-flex h-8 w-8 items-center justify-center rounded-md text-text-2"
        >
          <LuShare size={13} />
        </button>
        {p.marketId && (
          <a
            href={OBJECT_EXPLORER(p.marketId)}
            target="_blank"
            rel="noreferrer"
            aria-label="View market on Suiscan"
            className="ctrl-soft inline-flex h-8 w-8 items-center justify-center rounded-md text-text-2"
          >
            <LuExternalLink size={13} />
          </a>
        )}
        <ActionButton result={result} claim={claim} isRange={isRange} busy={busy || !!p.sample} onClick={() => onRedeem(p)} />
      </div>

      <ShareCardModal open={shareOpen} onClose={() => setShareOpen(false)} data={shareData} />
    </div>
  );
}

/** The result pill — mirrors the card's ResultChip, sized for a row. */
function StateChip({ result, isRange }: { result: Result; isRange: boolean }) {
  if (result === 'live') {
    return (
      <span className="flex-none rounded-full border border-line bg-white/3 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-text-2">
        Live
      </span>
    );
  }
  if (result === 'settling') {
    return (
      <span className="flex-none rounded-full border border-(--warn-soft) bg-(--warn-soft) px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-warn">
        Settling
      </span>
    );
  }
  const won = result === 'won';
  return (
    <span
      className={`flex-none rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${
        won ? 'bg-(--accent-soft) text-up' : 'bg-(--down-soft) text-down'
      }`}
    >
      {won ? (isRange ? 'In band' : 'Won') : isRange ? 'Out' : 'Lost'}
    </span>
  );
}

/** The state's primary action. The keeper auto-redeems settled positions, so a win shows a
 *  non-actionable "Paying out" (or a fallback Claim when the keeper is clearly late) and a
 *  loss shows "Lost" — only a live close or that fallback claim is a real button. */
function ActionButton({
  result,
  claim,
  isRange,
  busy,
  onClick,
}: {
  result: Result;
  claim: SettledClaimState;
  isRange: boolean;
  busy: boolean;
  onClick: () => void;
}) {
  if (result === 'settling') {
    return (
      <button
        disabled
        title="The oracle hasn't settled this market yet — the payout follows once it does."
        className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-3 opacity-70"
      >
        Awaiting <LuClock size={12} />
      </button>
    );
  }
  if (claim === 'auto_paying') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-up/40 bg-up/6 px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-up/90">
        Paying out
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-up motion-safe:animate-pulse" />
      </span>
    );
  }
  if (claim === 'auto_clearing') {
    return (
      <span className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-3">
        Lost
      </span>
    );
  }
  if (claim === 'clear_fallback') {
    // Settled loss the keeper hasn't cleared — a manual clear so it doesn't linger.
    return (
      <button
        onClick={onClick}
        disabled={busy}
        title="The automatic clear is late — clear this settled position yourself"
        className="inline-flex items-center gap-1.5 rounded-lg border border-line px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-text-2 transition-all hover:border-line-strong hover:text-text-1 disabled:opacity-50"
      >
        Clear <LuCircleX size={12} />
      </button>
    );
  }
  const isFallbackClaim = claim === 'claim_fallback';
  return (
    <button
      onClick={onClick}
      disabled={busy}
      title={isFallbackClaim ? 'The auto-payout is late — claim it yourself' : undefined}
      className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-[10px] font-semibold uppercase tracking-wider transition-all disabled:opacity-50 ${
        isFallbackClaim
          ? 'border-up/50 bg-up/10 text-up hover:bg-up/20'
          : 'border-down/45 text-down hover:bg-down/10'
      }`}
    >
      {isFallbackClaim ? 'Claim' : isRange ? 'Close' : 'Close'}
      {isFallbackClaim ? <LuDownload size={12} /> : <LuCircleX size={12} />}
    </button>
  );
}

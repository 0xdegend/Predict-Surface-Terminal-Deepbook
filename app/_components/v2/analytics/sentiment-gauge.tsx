'use client';

/**
 * V2SentimentGauge — the protocol's UP-vs-DOWN dollar imbalance (the "skew" the
 * app is named for), matching the legacy SentimentGauge: a glass-card with a
 * single split bar and per-side dollar/bet totals. Real, weighted by premium
 * staked across the recent minted orders (see useV2Analytics).
 */
import { useState } from 'react';
import { LuArrowUp, LuArrowDown, LuShare } from 'react-icons/lu';
import { compact, num } from '@/lib/format';
import type { Sentiment } from '@/lib/analytics/v2-aggregate';
import { SentimentShareModal } from '@/app/_components/analytics/sentiment-share-modal';

export function V2SentimentGauge({ sentiment, className = '' }: { sentiment: Sentiment; className?: string }) {
  const { upCost, downCost, upCount, downCount, upShare, totalCost } = sentiment;
  const hasFlow = totalCost > 0;
  const [shareOpen, setShareOpen] = useState(false);
  const upPct = Math.round(upShare * 100);
  const downPct = 100 - upPct;
  const lean = !hasFlow ? 'split' : upPct > 55 ? 'up' : downPct > 55 ? 'down' : 'split';
  const leanLabel = !hasFlow
    ? 'No bets yet'
    : lean === 'up'
      ? `Leans UP · ${upPct}%`
      : lean === 'down'
        ? `Leans DOWN · ${downPct}%`
        : 'Evenly split';

  return (
    <div className={`glass-card flex flex-col justify-center p-4 ${className}`}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className="eyebrow flex items-center gap-1.5 whitespace-nowrap text-text-3">
            Sentiment · recent bets
          </div>
          <div
            className={`mt-0.5 whitespace-nowrap text-[15px] font-semibold tracking-tight ${
              lean === 'up' ? 'text-up' : lean === 'down' ? 'text-down' : 'text-text-1'
            }`}
          >
            {leanLabel}
          </div>
        </div>
        <div className="flex flex-none items-center gap-2.5">
          <div className="text-right">
            <div className="eyebrow whitespace-nowrap text-text-3">Total bet</div>
            <div className="whitespace-nowrap font-mono text-[13px] tabular-nums text-text-2">
              {compact(totalCost)} <span className="text-text-3">DUSDC</span>
            </div>
          </div>
          {/* Share the sentiment read as a poster for X — only meaningful once
              there's flow to post about. */}
          {hasFlow && (
            <button
              type="button"
              onClick={() => setShareOpen(true)}
              aria-label="Share sentiment on X"
              title="Share sentiment"
              className="ctrl-soft flex h-8 w-8 flex-none items-center justify-center rounded-lg text-text-3 transition-colors hover:text-text-1"
            >
              <LuShare size={15} />
            </button>
          )}
        </div>
      </div>

      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg-3">
        <div className="h-full bg-up transition-[width] duration-700 ease-out" style={{ width: `${upPct}%` }} />
        <div className="h-full bg-down transition-[width] duration-700 ease-out" style={{ width: `${downPct}%` }} />
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <Side dir="up" pct={upPct} dollars={upCost} count={upCount} />
        <Side dir="down" pct={downPct} dollars={downCost} count={downCount} alignRight />
      </div>

      <SentimentShareModal open={shareOpen} onClose={() => setShareOpen(false)} sentiment={sentiment} />
    </div>
  );
}

function Side({
  dir,
  pct,
  dollars,
  count,
  alignRight = false,
}: {
  dir: 'up' | 'down';
  pct: number;
  dollars: number;
  count: number;
  alignRight?: boolean;
}) {
  const isUp = dir === 'up';
  const Icon = isUp ? LuArrowUp : LuArrowDown;
  return (
    <div className={alignRight ? 'text-right' : ''}>
      <div className={`flex items-center gap-1.5 ${alignRight ? 'justify-end' : ''} ${isUp ? 'text-up' : 'text-down'}`}>
        <Icon size={13} />
        <span className="text-[12px] font-semibold tracking-wide">{isUp ? 'UP' : 'DOWN'}</span>
        <span className="font-mono text-[13px] tabular-nums">{pct}%</span>
      </div>
      <div className="mt-0.5 whitespace-nowrap font-mono text-[11px] tabular-nums text-text-3">
        {num(dollars, 0)} DUSDC · {count} {count === 1 ? 'bet' : 'bets'}
      </div>
    </div>
  );
}

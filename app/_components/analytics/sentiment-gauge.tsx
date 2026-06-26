'use client';

/**
 * SentimentGauge — the protocol's UP-vs-DOWN dollar imbalance (the literal
 * "skew" the app is named for). A single horizontal bar split by the share of
 * DUSDC staked UP vs DOWN over the rolling window, with the dollar totals and
 * bet counts on each side. Reuses the semantic up/down tokens; no new accent.
 */
import { LuArrowUp, LuArrowDown } from 'react-icons/lu';
import type { Sentiment } from '@/lib/analytics/flow';
import { compact, num } from '@/lib/format';

export function SentimentGauge({ sentiment, className = '' }: { sentiment: Sentiment; className?: string }) {
  const { upCost, downCost, upCount, downCount, upShare, totalCost } = sentiment;
  const hasFlow = totalCost > 0;
  const upPct = Math.round(upShare * 100);
  const downPct = 100 - upPct;

  // Which side the crowd is leaning, for the headline read.
  const lean =
    !hasFlow ? 'balanced' : upPct > 55 ? 'up' : downPct > 55 ? 'down' : 'split';
  const leanLabel = {
    balanced: 'No bets yet',
    split: 'Evenly split',
    up: `Sentiment leans UP · ${upPct}%`,
    down: `Sentiment leans DOWN · ${downPct}%`,
  }[lean];

  return (
    <div className={`glass-card flex flex-col justify-center p-4 ${className}`}>
      <div className="mb-3 flex items-end justify-between gap-3">
        <div>
          <div className="eyebrow text-text-3">Sentiment · last hour</div>
          <div
            className={`mt-0.5 text-[15px] font-semibold tracking-tight ${
              lean === 'up' ? 'text-up' : lean === 'down' ? 'text-down' : 'text-text-1'
            }`}
          >
            {leanLabel}
          </div>
        </div>
        <div className="text-right">
          <div className="eyebrow text-text-3">Total bet</div>
          <div className="font-mono text-[13px] tabular-nums text-text-2">
            {compact(totalCost)} <span className="text-text-3">DUSDC</span>
          </div>
        </div>
      </div>

      {/* The split bar */}
      <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-bg-3">
        <div
          className="h-full bg-up transition-[width] duration-700 ease-out"
          style={{ width: `${hasFlow ? upPct : 50}%` }}
        />
        <div
          className="h-full bg-down transition-[width] duration-700 ease-out"
          style={{ width: `${hasFlow ? downPct : 50}%` }}
        />
      </div>

      {/* Per-side totals */}
      <div className="mt-3 grid grid-cols-2 gap-3">
        <Side
          dir="up"
          pct={hasFlow ? upPct : null}
          dollars={upCost}
          count={upCount}
        />
        <Side
          dir="down"
          pct={hasFlow ? downPct : null}
          dollars={downCost}
          count={downCount}
          alignRight
        />
      </div>
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
  pct: number | null;
  dollars: number;
  count: number;
  alignRight?: boolean;
}) {
  const isUp = dir === 'up';
  const Icon = isUp ? LuArrowUp : LuArrowDown;
  return (
    <div className={alignRight ? 'text-right' : ''}>
      <div
        className={`flex items-center gap-1.5 ${alignRight ? 'justify-end' : ''} ${
          isUp ? 'text-up' : 'text-down'
        }`}
      >
        <Icon size={13} />
        <span className="text-[12px] font-semibold tracking-wide">{isUp ? 'UP' : 'DOWN'}</span>
        <span className="font-mono text-[13px] tabular-nums">{pct === null ? '—' : `${pct}%`}</span>
      </div>
      <div className="mt-0.5 font-mono text-[11px] tabular-nums text-text-3">
        {num(dollars, 2)} DUSDC · {count} {count === 1 ? 'bet' : 'bets'}
      </div>
    </div>
  );
}

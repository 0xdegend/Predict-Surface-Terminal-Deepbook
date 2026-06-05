'use client';

/**
 * Performance bento — the trader's settled track record at a glance. Mirrors the
 * account-header bento: a tall win-rate hero (big %, a teal/coral split meter, the
 * W–L record) beside a 2×2 of supporting stats (realized PnL, record, best, streak).
 * Pure presentation; all numbers come pre-derived from `derivePortfolioHistory`.
 */
import type { IconType } from 'react-icons';
import { LuTarget, LuTrendingUp, LuTrendingDown, LuTrophy, LuFlame, LuSnowflake } from 'react-icons/lu';
import { quote as fmtQuote, signed, pct } from '@/lib/format';
import { HUE, IconChip } from '../ui/metric';
import type { WinStats } from '@/lib/portfolio/history';

export function PerformanceCard({ stats }: { stats: WinStats }) {
  const winPct = stats.winRate * 100;
  const winW = stats.total > 0 ? (stats.wins / stats.total) * 100 : 0;
  const streakWon = stats.streak?.result === 'won';

  return (
    <div className="glass-card grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums lg:grid-cols-3">
      {/* Win-rate hero */}
      <div className="glass-inset relative col-span-2 flex flex-col justify-between gap-5 overflow-hidden p-5 lg:col-span-1 lg:row-span-2">
        <span
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(120% 90% at 0% 0%, ${
              winPct >= 50 ? 'var(--accent-soft)' : 'var(--down-soft)'
            }, transparent 60%)`,
          }}
        />
        <div className="relative flex items-center gap-2.5">
          <IconChip icon={LuTarget} color={winPct >= 50 ? HUE.teal : HUE.coral} size={30} />
          <span className="eyebrow">Win rate</span>
        </div>

        <div className="relative flex flex-col gap-3">
          <span className="flex items-baseline gap-2">
            <span
              className={`text-[40px] leading-none tracking-tight ${
                winPct >= 50 ? 'text-up' : 'text-down'
              }`}
            >
              {pct(stats.winRate, 1)}
            </span>
            <span className="text-[11px] text-text-3">
              {stats.total} settled
            </span>
          </span>

          {/* teal/coral split meter */}
          <div className="flex h-2 overflow-hidden rounded-full bg-bg-3">
            <span className="h-full bg-up/80" style={{ width: `${winW}%` }} />
            <span className="h-full flex-1 bg-down/70" />
          </div>

          <div className="flex items-center justify-between text-[11px]">
            <span className="flex items-center gap-1.5 text-up">
              <span className="h-1.5 w-1.5 rounded-full bg-up" />
              {stats.wins}W
            </span>
            <span className="flex items-center gap-1.5 text-down">
              {stats.losses}L
              <span className="h-1.5 w-1.5 rounded-full bg-down" />
            </span>
          </div>

          {stats.unclaimed > 0 && (
            <span className="text-[10px] text-text-3">
              +{stats.unclaimed} settled awaiting claim
            </span>
          )}
        </div>
      </div>

      <Tile
        icon={stats.realizedPnl >= 0 ? LuTrendingUp : LuTrendingDown}
        color={stats.realizedPnl >= 0 ? HUE.teal : HUE.coral}
        label="Realized PnL"
        value={signed(stats.realizedPnl)}
        tone={stats.realizedPnl >= 0 ? 'up' : 'down'}
        sub={`on ${fmtQuote(stats.staked)} staked`}
      />
      <Tile
        icon={LuTrophy}
        color={HUE.amber}
        label="Best result"
        value={signed(stats.best)}
        tone={stats.best >= 0 ? 'up' : undefined}
        sub="single trade"
      />
      <Tile
        icon={LuTrendingUp}
        color={HUE.blue}
        label="Avg ROI"
        value={stats.staked > 0 ? pct(stats.realizedPnl / stats.staked, 1) : '—'}
        tone={stats.realizedPnl >= 0 ? 'up' : 'down'}
        sub="per trade staked"
      />
      <Tile
        icon={streakWon ? LuFlame : LuSnowflake}
        color={streakWon ? HUE.coral : HUE.blue}
        label="Current streak"
        value={stats.streak ? `${stats.streak.count}${streakWon ? 'W' : 'L'}` : '—'}
        tone={stats.streak ? (streakWon ? 'up' : 'down') : undefined}
        sub={streakWon ? 'on a heater' : stats.streak ? 'cold run' : 'no trades yet'}
      />
    </div>
  );
}

function Tile({
  icon,
  color,
  label,
  value,
  tone,
  sub,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  tone?: 'up' | 'down';
  sub?: string;
}) {
  const valueColor = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1';
  return (
    <div className="glass-inset flex flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} size={22} />
        <span className="eyebrow">{label}</span>
      </div>
      <span className={`text-[20px] leading-none tracking-tight ${valueColor}`}>{value}</span>
      {sub && <span className="text-[10px] text-text-3">{sub}</span>}
    </div>
  );
}

'use client';

/**
 * V2PositionCard — one position on the new deployment, in the legacy card
 * language: frosted glass, result hairline, direction orb hero with live PnL +
 * sparkline, a quiet metrics row, and a single glowing action.
 *
 * Driven by the normalized V2PortfolioPosition (real indexer rows or sample
 * rows — see lib/portfolio/v2.ts). Real-row fields the indexer doesn't report
 * yet render as "—"; sample rows show a Sample chip and keep actions disabled.
 */
import { useId } from 'react';
import type { IconType } from 'react-icons';
import {
  LuArrowUp,
  LuArrowDown,
  LuCalendarRange,
  LuLayers,
  LuPercent,
  LuTarget,
  LuTrendingUp,
  LuCircleX,
  LuDownload,
  LuExternalLink,
} from 'react-icons/lu';
import { quote as fmtQuote, price, pct, signed, dateUTC, countdown, shortId } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import type { V2PortfolioPosition } from '@/lib/portfolio/v2';

const OBJECT_EXPLORER = (id: string) =>
  `https://suiscan.xyz/${predictV2Config.network}/object/${id}`;

export function V2PositionCard({
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
  const up = p.direction !== 'Down';
  const remaining = p.expiry != null ? p.expiry - now : null;

  const result: 'live' | 'won' | 'lost' = p.settled
    ? (p.won ?? (p.pnl ?? 0) >= 0)
      ? 'won'
      : 'lost'
    : 'live';
  const won = result === 'won';
  const positive = (p.pnl ?? 0) >= 0;
  const isClaim = p.settled && won;

  // The single accent — a faded top hairline telling result at a glance.
  const accentColor =
    result === 'won' ? 'var(--up)' : result === 'lost' ? 'var(--down)' : up ? 'var(--up)' : 'var(--down)';

  const title = p.underlying ?? (p.marketId ? shortId(p.marketId) : 'Position');
  const condition =
    p.band != null
      ? `${title} between ${price(p.band.lower)} – ${price(p.band.higher)} at expiry`
      : p.strike != null
        ? `${title} ${up ? '≥' : '≤'} ${price(p.strike)} at expiry`
        : 'Resolves at market expiry';

  return (
    <div
      className={`glass-card interactive relative overflow-hidden font-mono text-[12px] tabular-nums ${up ? 'up' : 'down'} ${
        p.settled ? 'decided' : ''
      }`}
    >
      {/* result hairline */}
      <span
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-0.5"
        style={{
          background: `linear-gradient(90deg, transparent, ${accentColor}, transparent)`,
          opacity: result === 'live' ? 0.3 : 0.7,
        }}
      />

      <div className="@container flex flex-col gap-3 p-3.5 sm:p-4">
        {/* top rail */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${up ? 'bg-up' : 'bg-down'}`} />
            <span className="eyebrow">{title} Position</span>
          </span>
          {p.marketId && (
            <a
              href={OBJECT_EXPLORER(p.marketId)}
              target="_blank"
              rel="noreferrer"
              aria-label="View market on Suiscan"
              className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2"
            >
              <LuExternalLink size={13} />
            </a>
          )}
        </div>

        {/* hero — direction, the bet, PnL + sparkline (the one raised plane) */}
        <div className="glass-inset flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4">
          <div className="flex items-center gap-3">
            <span className={`dir-orb ${up ? 'up' : 'down'} ${p.direction === 'Range' ? 'scale-90' : ''}`} aria-hidden>
              {p.direction === 'Range' ? (
                <LuCalendarRange size={18} />
              ) : up ? (
                <LuArrowUp size={20} />
              ) : (
                <LuArrowDown size={20} />
              )}
            </span>
            <div className="flex flex-col gap-1">
              <h3 className="text-[15px] leading-none text-text-1">
                {title}
                {p.expiry != null && (
                  <>
                    {' '}
                    <span className="text-text-3">·</span> {dateUTC(p.expiry, false)}
                  </>
                )}
              </h3>
              <p className="font-sans text-[11px] text-text-2">{condition}</p>
              <div className="mt-1 flex items-center gap-2.5">
                <ResultChip result={result} />
                {p.sample && (
                  <span className="rounded-full border border-(--warn-soft) bg-(--warn-soft) px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-warn">
                    Sample
                  </span>
                )}
                {result === 'live' && remaining != null && (
                  <span className={`text-[11px] tabular-nums ${urgencyClass(remaining)}`}>
                    {`${countdown(p.expiry!, now)} left`}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3.5">
            <div className="flex flex-col items-end gap-1">
              <span className="eyebrow">{p.settled ? 'Realized' : 'Unrealized'} PnL</span>
              <span className={`flex items-baseline gap-1.5 ${positive ? 'text-up' : 'text-down'}`}>
                <span className="text-[30px] leading-none tracking-tight">
                  {p.pnl != null ? signed(p.pnl) : '—'}
                </span>
                <span className="text-[11px] text-text-3">DUSDC</span>
              </span>
              {p.pnl != null && p.cost != null && p.cost > 0 && (
                <span className={`text-[12px] ${positive ? 'text-up' : 'text-down'}`}>
                  {signed((p.pnl / p.cost) * 100, 1)}%
                </span>
              )}
            </div>
            {p.spark && p.spark.length >= 2 && (
              <div className="hidden @lg:block">
                <Sparkline data={p.spark} color={positive ? 'var(--up)' : 'var(--down)'} />
              </div>
            )}
          </div>
        </div>

        {/* metrics — monochrome, on the bare card surface */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-1 @lg:grid-cols-4">
          <Metric icon={LuLayers} label="Max payout" value={fmtQuote(p.qty)} sub="DUSDC" />
          <Metric
            icon={LuPercent}
            label="Avg entry"
            value={p.entryPrice != null ? pct(p.entryPrice, 1) : '—'}
            sub="implied"
          />
          <Metric
            icon={LuTarget}
            label={p.settled ? 'Settled' : 'Mark'}
            value={p.markPrice != null ? pct(p.markPrice, 1) : '—'}
            sub="implied"
          />
          <Metric
            icon={LuTrendingUp}
            label={p.settled ? (won ? 'Payout' : 'Final') : 'Value'}
            value={p.markValue != null ? fmtQuote(p.markValue) : '—'}
            sub="DUSDC"
          />
        </div>

        {/* footer — quiet disclaimer + the one action */}
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="font-sans text-[10px] leading-snug text-text-3">
            {p.sample
              ? 'Sample position — live ones appear here once you trade.'
              : p.settled && !won
                ? 'Settled out of the money — this bet paid nothing.'
                : 'Probabilistic · resolved at expiry.'}
          </p>
          <button
            onClick={() => onRedeem(p)}
            disabled={busy || p.sample}
            title={p.sample ? 'Sample position — nothing to redeem' : undefined}
            className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest transition-all disabled:opacity-50 ${
              p.settled && !won
                ? 'border-line text-text-3 hover:border-line-strong hover:bg-white/[0.04] hover:text-text-2'
                : isClaim
                  ? 'border-up/50 bg-up/10 text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/20'
                  : 'border-down/45 text-down hover:border-down/70 hover:bg-down/10'
            }`}
          >
            {p.settled && !won ? 'Clear' : isClaim ? 'Claim payout' : 'Close position'}
            {isClaim ? <LuDownload size={14} /> : <LuCircleX size={14} />}
          </button>
        </div>
      </div>
    </div>
  );
}

/** A real implied-probability sparkline (entry→now), area + line. */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const id = useId();
  const w = 112;
  const h = 38;
  const pad = 3;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (data.length - 1)) * (w - 2 * pad);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - 2 * pad);
  const line = data.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(data.length - 1).toFixed(1)} ${h} L${x(0).toFixed(1)} ${h} Z`;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="h-[38px] w-[112px]" preserveAspectRatio="none" aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** One primary metric: muted icon + label, value, quiet inline unit. */
function Metric({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: IconType;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-text-3">
        <Icon size={12} className="flex-none" />
        <span className="eyebrow">{label}</span>
      </div>
      <span className="flex items-baseline gap-1.5">
        <span className="text-[16px] leading-none tracking-tight text-text-1">{value}</span>
        <span className="text-[9px] uppercase tracking-widest text-text-3">{sub}</span>
      </span>
    </div>
  );
}

function ResultChip({ result }: { result: 'live' | 'won' | 'lost' }) {
  if (result === 'live') {
    return (
      <span className="rounded-full border border-line bg-white/3 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-text-2">
        Live
      </span>
    );
  }
  const won = result === 'won';
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
        won ? 'bg-(--accent-soft) text-up' : 'bg-(--down-soft) text-down'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${won ? 'bg-accent' : 'bg-down'}`} />
      {won ? 'Won' : 'Lost'}
    </span>
  );
}

/** Countdown coloring: calm under normal time, warm under 5m, hot under 1m. */
function urgencyClass(remainingMs: number): string {
  if (remainingMs <= 0) return 'text-text-3';
  if (remainingMs < 60_000) return 'text-down';
  if (remainingMs < 300_000) return 'text-warn';
  return 'text-text-2';
}

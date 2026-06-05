'use client';

import { useId, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuArrowUp,
  LuArrowDown,
  LuLayers,
  LuPercent,
  LuTarget,
  LuTrendingUp,
  LuClock,
  LuDollarSign,
  LuShieldCheck,
  LuActivity,
  LuHexagon,
  LuExternalLink,
  LuCircleX,
  LuDownload,
  LuShare2,
  LuCheck,
} from 'react-icons/lu';
import {
  quote as fmtQuote,
  price,
  pct,
  signed,
  dateUTC,
  countdown,
  shortId,
} from '@/lib/format';
import { toFloat } from '@/config/scale';
import { usePositionSpark } from '@/lib/hooks/use-position-spark';
import { positionMetrics } from './position-metrics';
import type { PositionSummary } from '@/lib/api/types';

const OBJECT_EXPLORER = (id: string) => `https://suiscan.xyz/testnet/object/${id}`;

/**
 * A position as a compact glass instrument panel, sized to sit two-per-row: a
 * top rail, a hero (direction orb, the bet, live PnL + a real implied-prob
 * sparkline), a primary metric grid, a secondary detail strip, and a
 * disclaimer + actions. Container-query responsive — the metric rows stay
 * single-row at half-width and only wrap on small screens. All amounts are
 * de-scaled in `positionMetrics`; we never re-scale here.
 */
export function PositionCard({
  position,
  now,
  onRedeem,
  busy,
}: {
  position: PositionSummary;
  now: number;
  onRedeem: (p: PositionSummary) => void;
  busy: boolean;
}) {
  const p = position;
  const m = positionMetrics(p);
  const spark = usePositionSpark(p);
  const up = p.is_up;
  const remaining = p.expiry - now;
  const expired = remaining <= 0;
  const decided = m.isSettled || expired;

  // A settled binary marks at 1 (won) or 0 (lost); fall back to PnL sign.
  const won = decided ? (m.markPrice ?? (m.pnl >= 0 ? 1 : 0)) >= 0.5 : null;
  const result: 'live' | 'won' | 'lost' = won === null ? 'live' : won ? 'won' : 'lost';
  const positive = m.pnl >= 0;
  const isRedeem = m.isSettled;
  const deltaPp = m.markPrice != null ? (m.markPrice - m.entryPrice) * 100 : null;
  const pnlColor = positive ? 'var(--up)' : 'var(--down)';

  const shareText =
    `${p.underlying_asset} ${up ? '≥' : '≤'} ${price(toFloat(p.strike))} · ${dateUTC(p.expiry)}\n` +
    `${decided ? 'Realized' : 'Unrealized'} PnL ${signed(m.pnl)} DUSDC (${signed(m.pnlPct * 100, 1)}%)\n` +
    `Oracle ${p.oracle_id}`;

  // The single accent in the card — a faded top hairline that tells result at a
  // glance (teal won, coral lost, quiet direction-tint while live).
  const accentColor = result === 'won' ? 'var(--up)' : result === 'lost' ? 'var(--down)' : up ? 'var(--up)' : 'var(--down)';

  return (
    <div
      className={`glass-card interactive relative overflow-hidden font-mono text-[12px] tabular-nums ${up ? 'up' : 'down'} ${
        decided ? 'decided' : ''
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
            <span className="eyebrow">{p.underlying_asset} Position</span>
          </span>
          <div className="flex items-center gap-1.5">
            <ShareButton text={shareText} icon />
            <a
              href={OBJECT_EXPLORER(p.oracle_id)}
              target="_blank"
              rel="noreferrer"
              aria-label="View oracle on Suiscan"
              className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2"
            >
              <LuExternalLink size={13} />
            </a>
          </div>
        </div>

        {/* hero — direction, the bet, live PnL + sparkline (the one raised plane) */}
        <div className="glass-inset flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-4">
          <div className="flex items-center gap-3">
            <span className={`dir-orb ${up ? 'up' : 'down'}`} aria-hidden>
              {up ? <LuArrowUp size={20} /> : <LuArrowDown size={20} />}
            </span>
            <div className="flex flex-col gap-1">
              <h3 className="text-[15px] leading-none text-text-1">
                {p.underlying_asset} <span className="text-text-3">·</span> {dateUTC(p.expiry)}
              </h3>
              <p className="font-sans text-[11px] text-text-2">
                {p.underlying_asset} {up ? '≥' : '≤'} {price(toFloat(p.strike))} at expiry
              </p>
              <div className="mt-1 flex items-center gap-2.5">
                <ResultChip result={result} />
                {!decided && (
                  <span className={`text-[11px] tabular-nums ${urgencyClass(remaining)}`}>
                    {expired ? 'expired' : `${countdown(p.expiry, now)} left`}
                  </span>
                )}
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3.5">
            <div className="flex flex-col items-end gap-1">
              <span className="eyebrow">{decided ? 'Realized' : 'Unrealized'} PnL</span>
              <span className={`flex items-baseline gap-1.5 ${positive ? 'text-up' : 'text-down'}`}>
                <span className="text-[30px] leading-none tracking-tight">{signed(m.pnl)}</span>
                <span className="text-[11px] text-text-3">DUSDC</span>
              </span>
              <span className={`text-[12px] ${positive ? 'text-up' : 'text-down'}`}>
                {signed(m.pnlPct * 100, 1)}%
              </span>
            </div>
            <div className="hidden @lg:block">
              <Sparkline data={spark} color={pnlColor} />
            </div>
          </div>
        </div>

        {/* metrics — monochrome, on the bare card surface, one faded hairline between
            the two tiers (no nested boxes, no vertical rules) */}
        <div className="flex flex-col gap-3 px-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 @lg:grid-cols-4">
            <Metric icon={LuLayers} label="Size" value={fmtQuote(m.contracts)} sub="contracts" />
            <Metric icon={LuPercent} label="Avg entry" value={pct(m.entryPrice, 1)} sub="implied" />
            <Metric
              icon={LuTarget}
              label={decided ? 'Settled' : 'Mark'}
              value={m.markPrice != null ? pct(m.markPrice, 1) : '—'}
              sub="implied"
            />
            <Metric
              icon={LuTrendingUp}
              label={decided ? (won ? 'Payout' : 'Final') : 'Value'}
              value={m.value != null ? fmtQuote(m.value) : '—'}
              sub="DUSDC"
            />
          </div>

          <div className="hairline-fade" />

          <div className="grid grid-cols-2 gap-x-4 gap-y-3 @md:grid-cols-3 @xl:grid-cols-5">
            <MiniMetric icon={LuClock} label="Entered" value={dateUTC(p.first_minted_at)} />
            <MiniMetric icon={LuDollarSign} label="Cost" value={`${fmtQuote(m.cost)} DUSDC`} />
            <MiniMetric icon={LuShieldCheck} label="Max payout" value={`${fmtQuote(m.maxPayout)} DUSDC`} />
            <MiniMetric
              icon={LuActivity}
              label="Net move"
              value={deltaPp != null ? `${signed(deltaPp, 1)} pp` : '—'}
              tone={deltaPp != null ? (deltaPp >= 0 ? 'up' : 'down') : undefined}
            />
            <MiniMetric
              icon={LuHexagon}
              label="Oracle"
              value={shortId(p.oracle_id)}
              href={OBJECT_EXPLORER(p.oracle_id)}
            />
          </div>
        </div>

        {/* footer — quiet one-line disclaimer + actions (redeem is the only glow) */}
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="font-sans text-[10px] leading-snug text-text-3">
            Probabilistic · resolved by oracle data.
          </p>
          <div className="flex items-center gap-2">
            <ShareButton text={shareText} />
            <button
              onClick={() => onRedeem(p)}
              disabled={busy}
              className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest transition-all disabled:opacity-50 ${
                isRedeem
                  ? 'border-up/50 bg-up/10 text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/20'
                  : 'border-down/45 text-down hover:border-down/70 hover:bg-down/10'
              }`}
            >
              {isRedeem ? 'Redeem position' : 'Close position'}
              {isRedeem ? <LuDownload size={14} /> : <LuCircleX size={14} />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Copy a position summary to the clipboard; the label confirms the action. */
function ShareButton({ text, icon }: { text: string; icon?: boolean }) {
  const [copied, setCopied] = useState(false);
  const share = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard unavailable — no-op */
    }
  };
  if (icon) {
    return (
      <button
        onClick={share}
        aria-label="Copy position summary"
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2 ${
          copied ? 'border border-(--accent-line) text-up' : 'ctrl-soft'
        }`}
      >
        {copied ? <LuCheck size={13} /> : <LuShare2 size={13} />}
      </button>
    );
  }
  return (
    <button
      onClick={share}
      className={`inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-text-2 ${
        copied ? 'border border-(--accent-line) text-up' : 'ctrl-soft'
      }`}
    >
      {copied ? 'Copied' : 'Share position'}
      {copied ? <LuCheck size={14} /> : <LuShare2 size={14} />}
    </button>
  );
}

/** A real implied-probability sparkline (entry→now), area + line. */
function Sparkline({ data, color }: { data: number[]; color: string }) {
  const id = useId();
  if (data.length < 2) return null;
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

/** One secondary metric: muted icon + label, value below. */
function MiniMetric({
  icon: Icon,
  label,
  value,
  href,
  tone,
}: {
  icon: IconType;
  label: string;
  value: string;
  href?: string;
  tone?: 'up' | 'down';
}) {
  const valueColor = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-2';
  const inner = (
    <>
      <div className="flex items-center gap-1.5 text-text-3">
        <Icon size={12} className="flex-none" />
        <span className="eyebrow">{label}</span>
      </div>
      <span className={`flex items-center gap-1 whitespace-nowrap text-[12px] ${valueColor}`}>
        {value}
        {href && <LuExternalLink size={11} className="text-text-3 transition-colors group-hover/mini:text-text-2" />}
      </span>
    </>
  );
  const cls = 'flex flex-col gap-1.5';
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`group/mini ${cls} -mx-1.5 rounded-md px-1.5 py-0.5 transition-colors hover:bg-white/2.5`}
    >
      {inner}
    </a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function ResultChip({ result }: { result: 'live' | 'won' | 'lost' }) {
  if (result === 'live') {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-line bg-white/3 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-text-2">
        <span className="live-dot scale-90" />
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

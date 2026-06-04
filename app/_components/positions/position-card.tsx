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
  LuInfo,
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
import { HUE, IconChip } from '../ui/metric';
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

  return (
    <div
      className={`glass-card interactive font-mono text-[12px] tabular-nums ${up ? 'up' : 'down'} ${
        decided ? 'decided' : ''
      }`}
    >
      <div className="@container flex flex-col gap-2 p-3 sm:p-3.5">
        {/* top rail */}
        <div className="flex items-center justify-between px-0.5">
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
              className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-line text-text-2 transition-colors hover:border-line-strong hover:text-text-1"
            >
              <LuExternalLink size={14} />
            </a>
          </div>
        </div>

        {/* hero — direction, the bet, live PnL + sparkline */}
        <div className="glass-inset flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-3.5">
          <div className="flex items-center gap-3">
            <span className={`dir-orb ${up ? 'up' : 'down'}`} aria-hidden>
              {up ? <LuArrowUp size={20} /> : <LuArrowDown size={20} />}
            </span>
            <div className="flex flex-col gap-1">
              <h3 className="text-[16px] leading-none text-text-1">
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

          <div className="flex items-center gap-3">
            <div className="flex flex-col items-end gap-0.5">
              <span className="eyebrow">{decided ? 'Realized' : 'Unrealized'} PnL</span>
              <span className={`flex items-baseline gap-1.5 ${positive ? 'text-up' : 'text-down'}`}>
                <span className="text-[24px] leading-none tracking-tight">{signed(m.pnl)}</span>
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

        {/* primary metrics */}
        <div className="glass-inset grid grid-cols-2 gap-y-1 @lg:grid-cols-4 @lg:gap-0 @lg:divide-x @lg:divide-(--line-soft)">
          <Metric icon={LuLayers} color={HUE.teal} label="Size" value={fmtQuote(m.contracts)} sub="Contracts" />
          <Metric icon={LuPercent} color={HUE.violet} label="Avg entry" value={pct(m.entryPrice, 1)} sub="Implied" />
          <Metric
            icon={LuTarget}
            color={HUE.blue}
            label={decided ? 'Settled' : 'Mark'}
            value={m.markPrice != null ? pct(m.markPrice, 1) : '—'}
            sub="Implied"
          />
          <Metric
            icon={LuTrendingUp}
            color={HUE.teal}
            label={decided ? (won ? 'Payout' : 'Final') : 'Value'}
            value={m.value != null ? fmtQuote(m.value) : '—'}
            sub="DUSDC"
          />
        </div>

        {/* secondary detail strip */}
        <div className="glass-inset grid grid-cols-2 gap-y-1 @md:grid-cols-3 @xl:grid-cols-5 @xl:gap-0 @xl:divide-x @xl:divide-(--line-soft)">
          <MiniMetric icon={LuClock} color={HUE.blue} label="Entered" value={dateUTC(p.first_minted_at)} />
          <MiniMetric icon={LuDollarSign} color={HUE.amber} label="Cost" value={`${fmtQuote(m.cost)} DUSDC`} />
          <MiniMetric icon={LuShieldCheck} color={HUE.amber} label="Max payout" value={`${fmtQuote(m.maxPayout)} DUSDC`} />
          <MiniMetric
            icon={LuActivity}
            color={HUE.teal}
            label="Net move"
            value={deltaPp != null ? `${signed(deltaPp, 1)} pp` : '—'}
            tone={deltaPp != null ? (deltaPp >= 0 ? 'up' : 'down') : undefined}
          />
          <MiniMetric
            icon={LuHexagon}
            color={HUE.blue}
            label="Oracle"
            value={shortId(p.oracle_id)}
            href={OBJECT_EXPLORER(p.oracle_id)}
          />
        </div>

        {/* footer — disclaimer + actions */}
        <div className="glass-inset flex flex-wrap items-center justify-between gap-3 px-3.5 py-3">
          <p className="flex items-center gap-2.5 font-sans text-[10px] leading-snug text-text-3">
            <span className="icon-chip h-5.5 w-5.5">
              <LuInfo size={12} />
            </span>
            Prediction markets are probabilistic · resolved by oracle data.
          </p>
          <div className="flex items-center gap-2">
            <ShareButton text={shareText} />
            <button
              onClick={() => onRedeem(p)}
              disabled={busy}
              className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest transition-colors disabled:opacity-50 ${
                isRedeem
                  ? 'border-(--accent-line) bg-(--accent-soft) text-up hover:bg-up/20'
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
        className={`inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors ${
          copied
            ? 'border-(--accent-line) text-up'
            : 'border-line text-text-2 hover:border-line-strong hover:text-text-1'
        }`}
      >
        {copied ? <LuCheck size={13} /> : <LuShare2 size={13} />}
      </button>
    );
  }
  return (
    <button
      onClick={share}
      className={`inline-flex items-center gap-2 rounded-lg border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest transition-colors ${
        copied
          ? 'border-(--accent-line) text-up'
          : 'border-line text-text-2 hover:border-line-strong hover:text-text-1'
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

/** One primary metric: tinted chip + label, big value, unit. */
function Metric({
  icon,
  color,
  label,
  value,
  sub,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flex flex-col gap-2 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <IconChip icon={icon} color={color} />
        <span className="eyebrow">{label}</span>
      </div>
      <div className="flex flex-col gap-0.5">
        <span className="text-[20px] leading-none tracking-tight text-text-1">{value}</span>
        <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">{sub}</span>
      </div>
    </div>
  );
}

/** One secondary metric: bare tinted icon + label, value below. */
function MiniMetric({
  icon: Icon,
  color,
  label,
  value,
  href,
  tone,
}: {
  icon: IconType;
  color: string;
  label: string;
  value: string;
  href?: string;
  tone?: 'up' | 'down';
}) {
  const valueColor = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : 'text-text-1';
  const inner = (
    <>
      <div className="flex items-center gap-1.5">
        <span style={{ color }} className="flex-none">
          <Icon size={13} />
        </span>
        <span className="eyebrow">{label}</span>
      </div>
      <span className={`flex items-center gap-1 whitespace-nowrap text-[12px] ${valueColor}`}>
        {value}
        {href && <LuExternalLink size={11} className="text-text-3" />}
      </span>
    </>
  );
  const cls = 'flex flex-col gap-1.5 px-3 py-2.5';
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className={`${cls} rounded-lg transition-colors hover:bg-white/[0.02]`}
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

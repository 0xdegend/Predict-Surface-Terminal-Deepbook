'use client';

/**
 * V2PositionCard — one position on the new deployment, at full parity with the
 * legacy position card (positions/position-card.tsx + range-position-card.tsx):
 * frosted glass, result hairline, direction/band orb hero with live PnL +
 * sparkline, a two-tier metric grid (primary tiles + a hairline + a mini row),
 * a Share-as-image button/modal, and a single glowing action.
 *
 * Driven by the normalized+enriched V2PortfolioPosition (real indexer rows, with
 * mark/PnL computed client-side off the live pricer — see lib/portfolio/v2.ts).
 * Handles Up / Down binaries AND Range bands. Sample rows show a Sample chip and
 * keep actions disabled. The `settling` state (expired, oracle not settled yet)
 * mirrors legacy: no verdict, redeem disabled until settlement lands.
 */
import { useId, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuArrowUp,
  LuArrowDown,
  LuCalendarRange,
  LuLayers,
  LuPercent,
  LuTarget,
  LuTrendingUp,
  LuClock,
  LuDollarSign,
  LuShieldCheck,
  LuActivity,
  LuHexagon,
  LuCircleX,
  LuDownload,
  LuExternalLink,
  LuShare,
} from 'react-icons/lu';
import { quote as fmtQuote, price, pct, signed, dateUTC, countdown, shortId } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { ShareCardModal } from '@/app/_components/positions/share-card-modal';
import type { ShareCardData } from '@/app/_components/positions/share-card-canvas';
import type { V2PortfolioPosition } from '@/lib/portfolio/v2';

const OBJECT_EXPLORER = (id: string) =>
  `https://suiscan.xyz/${predictV2Config.network}/object/${id}`;

type Result = 'live' | 'settling' | 'won' | 'lost';

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
  const [shareOpen, setShareOpen] = useState(false);
  const sym = predictV2Config.quote.symbol;
  const isRange = p.direction === 'Range';
  const up = p.direction !== 'Down';
  const remaining = p.expiry != null ? p.expiry - now : null;
  const expired = remaining != null && remaining <= 0;

  // Settled = a final verdict is known; settling = expired but no verdict yet
  // (v2 rows carry `won` only once the status is terminal). Live otherwise.
  const settling = !p.settled && expired;
  const won = p.settled ? (p.won ?? (p.pnl ?? 0) >= 0) : null;
  const result: Result = p.settled ? (won ? 'won' : 'lost') : settling ? 'settling' : 'live';
  const decided = p.settled;
  const positive = (p.pnl ?? 0) >= 0;
  const isClaim = decided && won === true;
  const worthless = decided && won === false;

  const title = p.underlying ?? (p.marketId ? shortId(p.marketId) : 'Position');
  const kindLabel = isRange ? 'Range' : 'Position';
  const condition = isRange
    ? p.band != null
      ? `${title} settles in this band · ${p.expiry != null ? dateUTC(p.expiry, false) : ''}`
      : 'Settles inside the band at expiry'
    : p.strike != null
      ? `${title} ${up ? '≥' : '≤'} ${price(p.strike)} at expiry`
      : 'Resolves at market expiry';

  const accentColor =
    result === 'won' ? 'var(--up)' : result === 'lost' ? 'var(--down)' : up ? 'var(--up)' : 'var(--down)';

  const shareData: ShareCardData = {
    underlying: title,
    up,
    strike: p.strike ?? 0,
    expiry: p.expiry ?? 0,
    // Settling has no verdict yet → share it as a live card.
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

  const heroTitle = isRange && p.band != null
    ? `${price(p.band.lower)} — ${price(p.band.higher)}`
    : title;

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
          opacity: result === 'live' || result === 'settling' ? 0.3 : 0.7,
        }}
      />

      <div className="@container flex flex-col gap-3 p-3.5 sm:p-4">
        {/* top rail */}
        <div className="flex items-center justify-between">
          <span className="flex items-center gap-2">
            <span className={`h-1.5 w-1.5 rounded-full ${up ? 'bg-up' : 'bg-down'}`} />
            <span className="eyebrow">
              {title} {kindLabel}
            </span>
          </span>
          <div className="flex items-center gap-1.5">
            <ShareButton onClick={() => setShareOpen(true)} icon />
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
        </div>

        {/* hero — direction/band, the bet, live PnL + sparkline. Left column
            flexes and truncates; the PnL block stays pinned to the right edge so
            the row always fills (never wraps the PnL onto its own half-empty line). */}
        <div className="glass-inset flex items-center justify-between gap-x-4 gap-y-3 p-4">
          <div className="flex min-w-0 flex-1 items-center gap-3">
            <span className={`dir-orb ${up ? 'up' : 'down'} ${isRange ? 'scale-90' : ''}`} aria-hidden>
              {isRange ? <LuCalendarRange size={18} /> : up ? <LuArrowUp size={20} /> : <LuArrowDown size={20} />}
            </span>
            <div className="flex min-w-0 flex-col gap-1">
              <h3 className="truncate text-[15px] leading-none text-text-1">
                {heroTitle}
                {!isRange && p.expiry != null && (
                  <>
                    {' '}
                    <span className="text-text-3">·</span> {dateUTC(p.expiry, false)}
                  </>
                )}
              </h3>
              <p className="truncate font-sans text-[11px] text-text-2">{condition}</p>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <ResultChip result={result} isRange={isRange} />
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
                {result === 'settling' && (
                  <span className="font-sans text-[11px] text-text-3">awaiting oracle settlement</span>
                )}
              </div>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-3.5">
            <div className="flex flex-col items-end gap-1">
              <span className="eyebrow">{decided ? 'Realized' : 'Unrealized'} PnL</span>
              <span className={`flex items-baseline gap-1.5 ${positive ? 'text-up' : 'text-down'}`}>
                <span className="text-[30px] leading-none tracking-tight">{p.pnl != null ? signed(p.pnl) : '—'}</span>
                <span className="text-[11px] text-text-3">{sym}</span>
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

        {/* metrics — two tiers, monochrome, one faded hairline between them */}
        <div className="flex flex-col gap-3 px-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 @lg:grid-cols-4">
            <Metric icon={LuLayers} label="Size" value={fmtQuote(p.qty)} sub="contracts" />
            <Metric
              icon={LuPercent}
              label="Avg entry"
              value={p.entryPrice != null ? pct(p.entryPrice, 1) : '—'}
              sub="implied"
            />
            <Metric
              icon={LuTarget}
              label={decided ? 'Settled' : isRange ? 'Chance in band' : 'Mark'}
              value={p.markPrice != null ? pct(p.markPrice, 1) : '—'}
              sub="implied"
            />
            <Metric
              icon={LuTrendingUp}
              label={decided ? (won ? 'Payout' : 'Final') : 'Value'}
              value={p.markValue != null ? fmtQuote(p.markValue) : '—'}
              sub={sym}
            />
          </div>

          <div className="hairline-fade" />

          <div className="grid grid-cols-2 gap-x-6 gap-y-3 @md:grid-cols-3 @xl:grid-cols-5">
            <MiniMetric icon={LuClock} label="Entered" value={p.openedAt != null ? dateUTC(p.openedAt, false) : '—'} />
            <MiniMetric icon={LuDollarSign} label="Cost" value={p.cost != null ? `${fmtQuote(p.cost)} ${sym}` : '—'} />
            <MiniMetric
              icon={LuShieldCheck}
              label={p.leverage != null && p.leverage > 1 ? 'Leverage' : 'Max payout'}
              value={p.leverage != null && p.leverage > 1 ? `${p.leverage.toFixed(0)}×` : `${fmtQuote(p.qty)} ${sym}`}
            />
            <MiniMetric
              icon={LuActivity}
              label="Net move"
              value={p.deltaPp != null ? `${signed(p.deltaPp, 1)}%` : '—'}
              tone={p.deltaPp != null ? (p.deltaPp >= 0 ? 'up' : 'down') : undefined}
            />
            <MiniMetric
              icon={LuHexagon}
              label="Market"
              value={p.marketId ? shortId(p.marketId) : '—'}
              href={p.marketId ? OBJECT_EXPLORER(p.marketId) : undefined}
            />
          </div>
        </div>

        {/* footer — quiet disclaimer + share + the one action */}
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3 px-1">
          <p className="font-sans text-[10px] leading-snug text-text-3">
            {p.sample
              ? 'Sample position — live ones appear here once you trade.'
              : worthless
                ? `Settled out of the ${isRange ? 'band' : 'money'} — this bet paid nothing.`
                : result === 'settling'
                  ? "Expired — waiting on the oracle's final settlement price."
                  : isRange
                    ? `Pays ${fmtQuote(p.qty)} ${sym} if ${title} settles in the band.`
                    : 'Probabilistic · resolved by oracle data.'}
          </p>
          <div className="flex items-center gap-2">
            <ShareButton onClick={() => setShareOpen(true)} />
            {result === 'settling' ? (
              <button
                disabled
                title="The oracle hasn't settled this market yet — redeem unlocks once it does."
                className="inline-flex shrink-0 cursor-not-allowed items-center gap-2 whitespace-nowrap rounded-lg border border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-text-3 opacity-70"
              >
                Awaiting settlement
                <LuClock size={14} />
              </button>
            ) : (
              <button
                onClick={() => onRedeem(p)}
                disabled={busy || p.sample}
                title={
                  p.sample
                    ? 'Sample position — nothing to redeem'
                    : worthless
                      ? 'Remove this settled position — it paid nothing'
                      : undefined
                }
                className={`inline-flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg border px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest transition-all disabled:opacity-50 ${
                  worthless
                    ? 'border-line text-text-3 hover:border-line-strong hover:bg-white/[0.04] hover:text-text-2'
                    : isClaim
                      ? 'border-up/50 bg-up/10 text-up shadow-[0_0_22px_-8px_var(--accent-glow)] hover:bg-up/20'
                      : 'border-down/45 text-down hover:border-down/70 hover:bg-down/10'
                }`}
              >
                {worthless
                  ? 'Clear'
                  : isClaim
                    ? isRange
                      ? 'Redeem range'
                      : 'Claim payout'
                    : isRange
                      ? 'Close range'
                      : 'Close position'}
                {worthless ? <LuCircleX size={14} /> : isClaim ? <LuDownload size={14} /> : <LuCircleX size={14} />}
              </button>
            )}
          </div>
        </div>
      </div>

      <ShareCardModal open={shareOpen} onClose={() => setShareOpen(false)} data={shareData} />
    </div>
  );
}

/** Opens the share-card dialog. Icon variant for the top rail, labelled for the footer. */
function ShareButton({ onClick, icon }: { onClick: () => void; icon?: boolean }) {
  if (icon) {
    return (
      <button
        onClick={onClick}
        aria-label="Share position as image"
        className="ctrl-soft inline-flex h-7 w-7 items-center justify-center rounded-md text-text-2"
      >
        <LuShare size={13} />
      </button>
    );
  }
  return (
    <button
      onClick={onClick}
      className="ctrl-soft inline-flex items-center gap-2 rounded-lg px-4 py-2.5 text-[11px] font-semibold uppercase tracking-widest text-text-2"
    >
      Share position
      <LuShare size={14} />
    </button>
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
function Metric({ icon: Icon, label, value, sub }: { icon: IconType; label: string; value: string; sub: string }) {
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
        {href && (
          <LuExternalLink size={11} className="text-text-3 transition-colors group-hover/mini:text-text-2" />
        )}
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

function ResultChip({ result, isRange }: { result: Result; isRange: boolean }) {
  if (result === 'live') {
    return (
      <span className="rounded-full border border-line bg-white/3 px-2 py-0.5 text-[10px] uppercase tracking-[0.12em] text-text-2">
        Live
      </span>
    );
  }
  if (result === 'settling') {
    return (
      <span className="flex items-center gap-1.5 rounded-full border border-(--warn-soft) bg-(--warn-soft) px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-warn">
        <span className="h-1.5 w-1.5 rounded-full bg-warn motion-safe:animate-pulse" />
        Settling
      </span>
    );
  }
  const won = result === 'won';
  const label = won ? (isRange ? 'In band' : 'Won') : isRange ? 'Out' : 'Lost';
  return (
    <span
      className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] ${
        won ? 'bg-(--accent-soft) text-up' : 'bg-(--down-soft) text-down'
      }`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${won ? 'bg-accent' : 'bg-down'}`} />
      {label}
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

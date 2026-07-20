'use client';

/**
 * V2MarketAnalysis — the "Analysis" tab of the trade rail. The surface (Odds tab)
 * tells a trader the FAIR probability of a strike; this tab tells them what the
 * wider market is doing and how the picked strike stacks up against what BTC has
 * actually been doing lately, then says it in plain words.
 *
 * Three layers, most-specific first:
 *   1. Auto read  — a plain-language synthesis (rule-built today; the same shape
 *                   an LLM will fill later — see lib/insights/market-read.ts).
 *   2. Your strike — required move vs how often it's happened vs the surface price
 *                    (only once a binary strike is picked; costs no extra calls).
 *   3. Market context — funding, open interest, liquidations, max pain, sentiment.
 *
 * All Clawby data is server-fetched + cached; the strike tape is strike-independent
 * so exploring strikes is free (see use-strike-analysis). This whole component is
 * MOUNT-GATED behind the Analysis tab, so nothing here fetches until it's opened.
 */
import { useMemo } from 'react';
import { LuSparkles } from 'react-icons/lu';
import { useBtcInsights, type BtcInsights } from '@/lib/hooks/use-btc-insights';
import { useStrikeAnalysis } from '@/lib/hooks/use-strike-analysis';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useNow } from '@/lib/hooks/use-now';
import { directionFair } from '@/lib/svi/invert';
import { num, compact, signed } from '@/lib/format';
import { buildMarketRead, type ReadTone } from '@/lib/insights/market-read';
import { strikeVerdict, type StrikeAnalysis } from '@/lib/insights/strike-analysis';
import { InfoTip } from '@/app/_components/ui/info-tip';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

const UP = 'var(--up)';
const DOWN = 'var(--down)';

function toneColor(tone: ReadTone): string {
  return tone === 'up' ? UP : tone === 'down' ? DOWN : tone === 'warn' ? 'var(--warn)' : 'var(--text-3)';
}

function sentimentColor(v: number): string {
  if (v < 45) return DOWN;
  if (v > 55) return UP;
  return 'var(--warn)';
}

export function V2MarketAnalysis({
  market,
  pricer,
  serverNow = 0,
}: {
  market?: V2Market | null;
  pricer?: LivePricer;
  serverNow?: number;
}) {
  const { data, loading } = useBtcInsights();
  const now = useNow(serverNow);

  const strikePrice = useV2TradeStore((s) => s.strikePrice);
  const isUp = useV2TradeStore((s) => s.isUp);
  const mode = useV2TradeStore((s) => s.mode);

  // Binary strike only — a range band is two levels and gets its own read later.
  const activeStrike = mode === 'binary' ? strikePrice : null;
  const forward = pricer?.forward ?? null;
  const impliedProb =
    activeStrike != null && pricer && forward != null
      ? directionFair(activeStrike, forward, pricer.svi, isUp)
      : null;

  const { analysis, settling } = useStrikeAnalysis({
    strike: activeStrike,
    spot: forward,
    isUp,
    expiryMs: market?.expiry ?? null,
    impliedProb,
    now,
  });

  const secsLeft = market ? Math.max(0, Math.round((market.expiry - now) / 1000)) : 0;
  const timeLeft = secsLeft >= 90 ? `${Math.round(secsLeft / 60)} min` : `${secsLeft}s`;

  const read = useMemo(
    () =>
      buildMarketRead({
        ctx: data ?? null,
        strike: analysis,
        isUp,
        strikePrice: activeStrike,
        spot: forward,
        timeLeftLabel: timeLeft,
      }),
    [data, analysis, isUp, activeStrike, forward, timeLeft],
  );

  if (loading && !data) return <AnalysisSkeleton />;

  // Data layer not configured (no key) → a quiet note rather than an empty tab.
  if (!data || !data.available) {
    return (
      <div className="glass-card px-4 py-6 text-center text-[12px] text-text-3">
        Live market data isn&apos;t available right now.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {read && <MarketReadout headline={read.headline} lines={read.lines} change24hPct={data.change24hPct} />}

      {activeStrike != null && (
        <StrikeCard
          analysis={analysis}
          strikePrice={activeStrike}
          isUp={isUp}
          timeLeft={timeLeft}
          settling={settling}
        />
      )}

      <MarketContextStats data={data} />

      <p className="text-center text-[9.5px] text-text-3">live · Clawby data · refreshes every 60s</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Auto read — the plain-language synthesis (rule-built for now).
 * ------------------------------------------------------------------ */
function MarketReadout({
  headline,
  lines,
  change24hPct,
}: {
  headline: string;
  lines: { tone: ReadTone; text: string }[];
  change24hPct: number | null;
}) {
  return (
    <div className="glass-inset flex flex-col gap-2.5 p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-[9.5px] uppercase tracking-[0.12em] text-text-3">
          <LuSparkles size={11} className="text-accent" />
          Auto read
        </span>
        {change24hPct != null && (
          <span
            className="flex shrink-0 items-baseline gap-1 rounded-md px-1.5 py-0.5 font-mono text-[10.5px] tabular-nums"
            style={{
              color: change24hPct >= 0 ? UP : DOWN,
              background: change24hPct >= 0 ? 'var(--accent-soft)' : 'var(--down-soft)',
            }}
          >
            {signed(change24hPct, 2)}%<span className="text-[9px] opacity-70">24h</span>
          </span>
        )}
      </div>

      <p className="text-[12.5px] font-medium leading-snug text-text-1">{headline}</p>

      <ul className="flex flex-col gap-1.5">
        {lines.map((l, i) => (
          <li key={i} className="flex items-start gap-1.5">
            <span aria-hidden className="mt-1.5 h-1 w-1 shrink-0 rounded-full" style={{ background: toneColor(l.tone) }} />
            <span className="text-[11px] leading-snug text-text-2">{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Your strike — the per-strike numbers behind the read's first line.
 * ------------------------------------------------------------------ */
function StrikeCard({
  analysis,
  strikePrice,
  isUp,
  timeLeft,
  settling,
}: {
  analysis: StrikeAnalysis | null;
  strikePrice: number;
  isUp: boolean;
  timeLeft: string;
  settling: boolean;
}) {
  return (
    <div
      className="glass-inset flex flex-col gap-2.5 p-2.5 transition-opacity duration-200"
      style={{ opacity: settling ? 0.45 : 1, borderColor: `color-mix(in srgb, ${isUp ? UP : DOWN} 18%, transparent)` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[9.5px] uppercase tracking-[0.12em] text-text-3">Your strike</span>
        <span className="font-mono text-[11px] tabular-nums" style={{ color: isUp ? UP : DOWN }}>
          ${num(strikePrice, 0)} · {isUp ? 'UP' : 'DOWN'}
        </span>
      </div>

      {analysis ? (
        <>
          <div className="font-mono text-[11px] leading-relaxed tabular-nums text-text-2">
            Needs <span className="text-text-1">{signed(analysis.requiredMovePct, 2)}%</span>{' '}
            <span className="text-text-3">(${num(Math.abs(analysis.requiredMoveUsd), 0)})</span> in{' '}
            <span className="text-text-1">{timeLeft}</span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <MiniStat
              label="Happened lately"
              value={analysis.empirical ? `${(analysis.empirical.prob * 100).toFixed(0)}%` : '—'}
              sub={analysis.empirical ? `${num(analysis.empirical.samples, 0)} past windows` : 'too few samples'}
            />
            <MiniStat
              label="Surface price"
              value={analysis.implied != null ? `${(analysis.implied * 100).toFixed(0)}%` : '—'}
              sub="fair odds now"
            />
          </div>
        </>
      ) : (
        <div className="font-mono text-[10.5px] text-text-3">Reading recent moves…</div>
      )}
    </div>
  );
}

function MiniStat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="truncate text-[9px] uppercase tracking-widest text-text-3">{label}</span>
      <span className="font-mono text-[15px] leading-none tabular-nums text-text-1">{value}</span>
      <span className="truncate text-[9px] text-text-3">{sub}</span>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Market context — the raw Clawby figures the read is built from.
 * ------------------------------------------------------------------ */
export function MarketContextStats({ data }: { data: BtcInsights }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="grid grid-cols-2 gap-2">
        <Stat
          label="Funding · 8h"
          sub={data.funding.binancePct != null ? 'Binance perp' : undefined}
          value={
            data.funding.binancePct != null ? (
              <span style={{ color: data.funding.binancePct >= 0 ? UP : DOWN }}>{signed(data.funding.binancePct, 3)}%</span>
            ) : null
          }
        />
        <Stat
          label="Open interest"
          sub={data.oiUsd != null ? 'All venues' : undefined}
          value={data.oiUsd != null ? <>${compact(data.oiUsd)}</> : null}
        />
        <Stat
          label="24h liquidations"
          sub={
            data.liq24h.longUsd != null && data.liq24h.shortUsd != null ? (
              <>
                <span style={{ color: DOWN }}>L {compact(data.liq24h.longUsd)}</span>
                <span className="px-1 opacity-40">·</span>
                <span style={{ color: UP }}>S {compact(data.liq24h.shortUsd)}</span>
              </>
            ) : undefined
          }
          value={data.liq24h.totalUsd != null ? <>${compact(data.liq24h.totalUsd)}</> : null}
        />
        <Stat
          label="Max pain"
          sub={data.maxPain ? `Deribit · ${data.maxPain.date}` : undefined}
          value={data.maxPain ? <>${num(data.maxPain.strike, 0)}</> : null}
        />
      </div>

      {data.sentiment && <SentimentGauge value={data.sentiment.value} label={data.sentiment.label} />}
    </div>
  );
}

/**
 * Fear ↔ greed as a recessed track with a needle, not a bare score. The gradient
 * runs coral → amber → teal (the terminal's up/down language), so where the
 * needle sits IS the reading — no need to know the scale or which end is which.
 */
function SentimentGauge({ value, label }: { value: number; label: string }) {
  const pct = Math.min(100, Math.max(0, value));
  const color = sentimentColor(value);
  return (
    <div className="glass-inset flex flex-col gap-2 p-2.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[9.5px] uppercase tracking-[0.12em] text-text-3">Market sentiment</span>
        <span className="text-[11.5px] font-medium" style={{ color }}>
          {label}
        </span>
      </div>
      <div
        className="relative h-1.5 w-full rounded-full"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`Market sentiment: ${label}`}
        style={{
          background: `linear-gradient(90deg, ${DOWN} 0%, var(--warn) 50%, ${UP} 100%)`,
          opacity: 0.8,
          boxShadow: 'inset 0 1px 2px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.05)',
        }}
      >
        <span
          aria-hidden
          className="absolute top-1/2 h-3 w-0.75 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white transition-[left] duration-500"
          style={{ left: `${pct}%`, boxShadow: '0 0 0 1.5px rgba(0,0,0,0.5), 0 0 8px rgba(255,255,255,0.35)' }}
        />
      </div>
      <div className="flex justify-between text-[9px] uppercase tracking-widest text-text-3">
        <span>Extreme fear</span>
        <span>Extreme greed</span>
      </div>
    </div>
  );
}

/**
 * One metric as a raised glass tile. Fixed label / value / sub rhythm keeps the
 * four tiles the same height so the 2×2 stays a grid, with the sub line carrying
 * the qualifier (venue, split, expiry).
 */
function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-1 p-2.5">
      <span className="truncate text-[9.5px] uppercase tracking-[0.12em] text-text-3">{label}</span>
      <span className="truncate font-mono text-[13px] leading-none tabular-nums text-text-1">
        {value ?? <span className="text-text-3">—</span>}
      </span>
      <span className="truncate font-mono text-[9.5px] leading-none tabular-nums text-text-3">{sub ?? ' '}</span>
    </div>
  );
}

function AnalysisSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <div className="glass-inset h-24 animate-pulse" />
      <div className="grid grid-cols-2 gap-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass-inset h-14.5 animate-pulse" />
        ))}
      </div>
    </div>
  );
}

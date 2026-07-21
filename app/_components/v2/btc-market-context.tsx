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
import { LuSparkles, LuLock } from 'react-icons/lu';
import { useBtcInsights, type BtcInsights } from '@/lib/hooks/use-btc-insights';
import { useStrikeAnalysis } from '@/lib/hooks/use-strike-analysis';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useNow } from '@/lib/hooks/use-now';
import { directionFair } from '@/lib/svi/invert';
import { num, compact, signed } from '@/lib/format';
import { buildMarketRead, type ReadTone } from '@/lib/insights/market-read';
import { strikeVerdict, type StrikeAnalysis } from '@/lib/insights/strike-analysis';
import { InfoTip } from '@/app/_components/ui/info-tip';
import { HUE, IconChip } from '../ui/metric';
import type { V2Market } from '@/lib/api/v2/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';

/**
 * Feature gate for the whole Analysis tab. OFF ships a blurred "coming soon"
 * preview built from STATIC sample data that fetches NOTHING — so no Clawby
 * credits are spent while the feature is dark. Flip to ON (env below) to serve
 * the real, live analysis. Inlined at build time, so activating needs a redeploy.
 */
export const ANALYSIS_ACTIVE = process.env.NEXT_PUBLIC_ANALYSIS_ACTIVE === 'true';

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

/**
 * V2MarketAnalysis — the tab entry point. While the feature is dark it renders
 * the blurred preview (NO hooks, NO fetches, so zero Clawby spend); once
 * activated it renders the live analysis. The branch is at the component
 * boundary, so the live component's data hooks only ever run when active.
 */
export function V2MarketAnalysis(props: { market?: V2Market | null; pricer?: LivePricer; serverNow?: number }) {
  if (!ANALYSIS_ACTIVE) return <AnalysisPreview />;
  return <LiveMarketAnalysis {...props} />;
}

function LiveMarketAnalysis({
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

  // A picked strike focuses the view on THAT bet; without one, we show the
  // wider-market read. The two never stack — picking a strike swaps the general
  // BTC breakdown (stat tiles + sentiment) out for the strike's own analysis.
  return (
    <div className="flex flex-col gap-3">
      {read && <MarketReadout headline={read.headline} lines={read.lines} change24hPct={data.change24hPct} />}

      {activeStrike != null ? (
        <StrikeCard
          analysis={analysis}
          strikePrice={activeStrike}
          isUp={isUp}
          timeLeft={timeLeft}
          settling={settling}
        />
      ) : (
        <MarketContextStats data={data} />
      )}

      <p className="text-center text-[9.5px] text-text-3">live · Clawby data · refreshes every 60s</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Preview (feature dark) — the real layout rendered from STATIC sample
 * data, blurred and locked. It calls no hooks and hits no endpoint, so
 * it costs zero Clawby credits no matter how many traders open the tab.
 * ------------------------------------------------------------------ */

/** Plausible-looking placeholder — clearly a teaser, never presented as live. */
const SAMPLE_INSIGHTS: BtcInsights = {
  available: true,
  asOf: 0,
  spot: 65_000,
  change24hPct: 1.24,
  oiUsd: 50.9e9,
  funding: { binancePct: 0.006, avgPct: 0.004 },
  liq24h: { totalUsd: 24.5e6, longUsd: 8.2e6, shortUsd: 16.3e6 },
  maxPain: { strike: 65_500, date: '2026-07-22' },
  sentiment: { value: 38, label: 'Fear' },
};

function AnalysisPreview() {
  // Pure + memoized: buildMarketRead never fetches, so the teaser text is
  // generated the same way the live one is, just from the sample above.
  const read = useMemo(
    () =>
      buildMarketRead({
        ctx: SAMPLE_INSIGHTS,
        strike: null,
        isUp: true,
        strikePrice: null,
        spot: SAMPLE_INSIGHTS.spot,
      }),
    [],
  );

  return (
    <div className="relative overflow-hidden rounded-2xl">
      {/* The real layout, blurred and made completely inert (no pointer, no
          selection, hidden from the a11y tree) — it's decorative here. */}
      <div aria-hidden className="pointer-events-none select-none flex flex-col gap-3 blur-sm">
        {read && <MarketReadout headline={read.headline} lines={read.lines} change24hPct={SAMPLE_INSIGHTS.change24hPct} />}
        <MarketContextStats data={SAMPLE_INSIGHTS} />
      </div>

      {/* Lock scrim + message. */}
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-2xl bg-bg-0/45 px-6 text-center backdrop-blur-[1px]">
        <IconChip icon={LuLock} color={HUE.blue} size={30} />
        <span className="text-[13px] font-semibold tracking-tight text-text-1">Market analysis is coming soon</span>
        <span className="max-w-60 text-[11px] leading-snug text-text-3">
          Live BTC insights and per-strike analysis unlock here shortly.
        </span>
      </div>
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
 * Both percentages are the SAME thing — the chance this bet wins — from two
 * independent sources, so the card frames them that way and says which is
 * higher. That framing is what makes the two numbers legible side by side.
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
  const pos = analysis ? positionLine(analysis, isUp, timeLeft) : null;
  const verdict = analysis ? strikeVerdict(analysis) : null;

  return (
    <div
      className="glass-inset flex flex-col gap-2.5 p-2.5 transition-opacity duration-200"
      style={{ opacity: settling ? 0.45 : 1, borderColor: `color-mix(in srgb, ${isUp ? UP : DOWN} 18%, transparent)` }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="flex items-center gap-1 text-[9.5px] uppercase tracking-[0.12em] text-text-3">
          Your bet
          <InfoTip label="your bet">
            The price and direction you picked. <b>UP</b> wins if BTC settles above your strike at the
            countdown; <b>DOWN</b> wins if it settles below.
          </InfoTip>
        </span>
        <span className="font-mono text-[11px] tabular-nums" style={{ color: isUp ? UP : DOWN }}>
          ${num(strikePrice, 0)} · {isUp ? 'UP' : 'DOWN'}
        </span>
      </div>

      {analysis && pos ? (
        <>
          {/* Where it stands right now, in plain words (winning / needs a move). */}
          <div className="text-[11px] leading-snug" style={{ color: toneColor(pos.tone) === 'var(--text-3)' ? 'var(--text-2)' : toneColor(pos.tone) }}>
            {pos.text}
          </div>

          <div className="flex flex-col gap-1.5 border-t border-white/5 pt-2">
            <span className="flex items-center gap-1 text-[9px] uppercase tracking-widest text-text-3">
              Chance this bet wins
              <InfoTip label="chance this bet wins">
                Two takes on the very same thing — how likely this bet is to win. One counts what BTC
                actually did recently; the other is the live price you&apos;d pay. When they disagree,
                that gap is the whole point.
              </InfoTip>
            </span>
            <div className="grid grid-cols-2 gap-2">
              <MiniStat
                label="From history"
                value={analysis.empirical ? `${(analysis.empirical.prob * 100).toFixed(0)}%` : '—'}
                sub={analysis.empirical ? `${num(analysis.empirical.samples, 0)} recent windows` : 'too few samples'}
                tip={
                  <>
                    Over the last ~33 hours we looked at every {timeLeft}-long window of BTC prices and
                    counted how often it ended on your winning side. Recent history, not a forecast.
                  </>
                }
              />
              <MiniStat
                label="From the price"
                value={analysis.implied != null ? `${(analysis.implied * 100).toFixed(0)}%` : '—'}
                sub="live surface odds"
                tip={
                  <>
                    What the surface charges for this bet right now — the market&apos;s own view of the
                    odds, and effectively what you pay.
                  </>
                }
              />
            </div>
          </div>

          {/* The takeaway: which is higher, in one plain line. */}
          {verdict && verdict.tone !== 'none' && (
            <div className="flex items-start gap-1.5 border-t border-white/5 pt-2">
              <span
                aria-hidden
                className="mt-1 h-1 w-1 shrink-0 rounded-full"
                style={{ background: verdict.tone === 'rich' ? DOWN : verdict.tone === 'cheap' ? UP : 'var(--text-3)' }}
              />
              <span className="text-[10.5px] leading-snug text-text-2">{verdict.text}</span>
            </div>
          )}
        </>
      ) : (
        <div className="font-mono text-[10.5px] text-text-3">Reading recent moves…</div>
      )}
    </div>
  );
}

/**
 * Where the bet stands right now, direction-aware. "Needs -0.01%" is meaningless
 * to a trader — a negative required move means the strike is already on the
 * WINNING side. So we say that instead: already winning (with the cushion), needs
 * a move (with the direction), or sitting right on the strike (a coin flip).
 */
function positionLine(a: StrikeAnalysis, isUp: boolean, timeLeft: string): { text: string; tone: ReadTone } {
  const usd = Math.abs(a.requiredMoveUsd);
  // Essentially on the line — the sign of a few dollars on $65k is noise.
  if (Math.abs(a.requiredMovePct) < 0.05) {
    return { tone: 'neutral', text: `Sitting right on your strike — close to a coin flip on where it lands in ${timeLeft}.` };
  }
  // requiredMoveUsd = strike − spot. UP wins above the strike, so it's already
  // winning when the strike sits below spot (negative); mirror for DOWN.
  const winningNow = isUp ? a.requiredMoveUsd < 0 : a.requiredMoveUsd > 0;
  if (winningNow) {
    return {
      tone: 'up',
      text: `Winning right now — BTC is $${num(usd, 0)} ${isUp ? 'above' : 'below'} your strike and just needs to hold for ${timeLeft}.`,
    };
  }
  return {
    tone: 'neutral',
    text: `Needs BTC to ${isUp ? 'rise' : 'fall'} $${num(usd, 0)} (${signed(a.requiredMovePct, 2)}%) within ${timeLeft}.`,
  };
}

function MiniStat({ label, value, sub, tip }: { label: string; value: string; sub: string; tip?: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <span className="flex items-center gap-1 truncate text-[9px] uppercase tracking-widest text-text-3">
        {label}
        {tip && <InfoTip label={label}>{tip}</InfoTip>}
      </span>
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

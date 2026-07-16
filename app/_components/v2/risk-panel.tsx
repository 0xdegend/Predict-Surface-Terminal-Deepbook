'use client';

/**
 * V2RiskPanel — "is the pool safe?" for the NEW deployment, the v2 counterpart of
 * the legacy RiskPanel. Same instrument language (bento figures, radial gauges,
 * share-price chart, a stress simulator) driven by real v2 data:
 *  - utilization + withdrawal headroom from the vault snapshot;
 *  - coverage of the pool against the gross max payout it could owe (aggregate
 *    open interest across the active book);
 *  - an adverse-settlement stress derived from that coverage;
 *  - share price over time from the keeper flush history.
 *
 * Why the stress is a solvency model, not legacy's ±Nσ spot shock: v2's open-
 * interest endpoint is aggregate (a market's total max-payout-at-risk, not the
 * per-strike book), so a spot-shock reprice would be guessing positions we can't
 * see. The coverage stress uses only what the chain reports and is deliberately
 * conservative — see lib/risk/v2.
 */
import { useMemo, useState } from 'react';
import type { IconType } from 'react-icons';
import {
  LuShieldCheck,
  LuVault,
  LuGauge,
  LuTrendingUp,
  LuSlidersHorizontal,
  LuLayers,
  LuHexagon,
} from 'react-icons/lu';
import { useV2Risk } from '@/lib/hooks/use-v2-risk';
import { useNow } from '@/lib/hooks/use-now';
import { stressPoint } from '@/lib/risk/v2';
import { quote as fmtQuote, num, compact, signed, pct, countdown, shortId, ago } from '@/lib/format';
import { predictV2Config } from '@/config/predict';
import { HUE, IconChip } from '../ui/metric';
import { InfoTip } from '../ui/info-tip';
import { RadialGauge, Gauge } from '../ui/gauges';
import { PerfChart } from '../ui/perf-chart';
import type { V2Market } from '@/lib/api/v2/types';

const OBJECT_EXPLORER = (id: string) =>
  `https://suiscan.xyz/${predictV2Config.network}/object/${id}`;

/** Demo amplifiers for the stress — the live testnet book is tiny, so ×1 barely
 *  moves a 10M pool. ×1 is strictly live; the rest scale the at-risk book so the
 *  mechanism is visible in a demo. Mirrors legacy's STRESS_STEPS. */
const STRESS_STEPS = [1, 100, 1000] as const;

const sym = predictV2Config.quote.symbol;

export function V2RiskPanel({ initialMarkets = [] }: { initialMarkets?: V2Market[] }) {
  const { risk, series, latestFlush, isLoading } = useV2Risk(initialMarkets);
  const now = useNow(0);

  const [adverse, setAdverse] = useState(0.5); // fraction of the book that wins
  const [amp, setAmp] = useState<(typeof STRESS_STEPS)[number]>(1);

  // Amplify the at-risk book for the demo without touching the live numbers the
  // rest of the panel shows. Coverage/outflow scale with it; the pool doesn't.
  const stressed = useMemo(() => {
    if (!risk) return null;
    const amplified = { ...risk, maxPayoutAtRisk: risk.maxPayoutAtRisk * amp };
    return stressPoint(amplified, adverse);
  }, [risk, adverse, amp]);

  if (isLoading && !risk) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
        <div className="glass-card h-64 animate-pulse rounded-xl" />
      </main>
    );
  }
  if (!risk) return null;

  const { snapshot, sharePrice, utilization, headroom, maxPayoutAtRisk, coverage, exposures } = risk;
  const coverageDisplay = Number.isFinite(coverage) ? `${num(coverage, coverage >= 100 ? 0 : 1)}×` : '∞';
  const allTimeChange = series.length >= 2 ? sharePrice / series[0].share_price - 1 : 0;

  // Amplified coverage for the worst-case caption under the stress.
  const ampMaxPayout = maxPayoutAtRisk * amp;
  const ampCoverage = ampMaxPayout > 0 ? snapshot.poolValue / ampMaxPayout : Infinity;

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-6 sm:px-5">
      <header>
        <p className="eyebrow mb-1">Latest · Vault Risk</p>
        <h1 className="flex items-center gap-2 text-[20px] font-semibold tracking-tight text-text-1">
          <LuShieldCheck size={18} className="text-accent" />
          Is the pool safe?
        </h1>
        <p className="mt-1 max-w-2xl text-[12px] text-text-3">
          A live health check on the liquidity pool — how much is at work, how much you could
          withdraw right now, how far it covers what it might owe, and how it holds up if bets go
          against it.
        </p>
      </header>

      {/* Key figures — bento */}
      <div className="glass-card grid grid-cols-2 gap-2.5 p-2.5 font-mono tabular-nums lg:grid-cols-3">
        <div className="glass-inset relative col-span-2 flex flex-col gap-3 overflow-hidden p-4 lg:col-span-1">
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{ background: 'radial-gradient(120% 90% at 0% 0%, var(--accent-soft), transparent 60%)' }}
          />
          <div className="relative flex items-center gap-2.5">
            <IconChip icon={LuVault} color={HUE.teal} size={28} />
            <span className="eyebrow">Pool value</span>
          </div>
          <span className="relative text-[30px] leading-none tracking-tight text-text-1">
            {fmtQuote(snapshot.poolValue)}
          </span>
          <span className="relative text-[10px] uppercase tracking-[0.12em] text-text-3">
            {sym} · backs every open bet
          </span>
        </div>

        <Fig label="Share price" value={num(sharePrice, 6)} sub="per PLP share" />
        <Fig
          label="Coverage"
          value={coverageDisplay}
          sub="worst-case payout"
          info="Pool value ÷ the most it could owe if every open bet won at once. A conservative floor — real payouts net the premiums already in the pool, so true coverage is higher."
        />
        <Fig label="Total shares" value={fmtQuote(snapshot.totalShares)} base={snapshot.totalShares} sub="PLP outstanding" />
        <Fig label="Withdrawable now" value={fmtQuote(snapshot.idle)} base={snapshot.idle} sub={`${sym} idle`} />
        <Fig
          label="At work"
          value={fmtQuote(snapshot.deployed)}
          base={snapshot.deployed}
          sub={`${sym} backing bets`}
          info="Capital the pool has committed to back open markets. It returns to idle as those markets settle."
        />
      </div>

      {/* Gauges + max-payout meter */}
      <div className="glass-card flex flex-col gap-5 p-5">
        <CardTitle icon={LuGauge} color={HUE.amber}>
          Pool health
        </CardTitle>
        <div className="grid grid-cols-2 justify-items-center gap-6 sm:grid-cols-3">
          <RadialGauge
            value={utilization}
            display={pct(utilization * 100, utilization < 0.1 ? 1 : 0)}
            label="In use"
            caption={`${fmtQuote(snapshot.deployed)} deployed`}
            color={utilization > 0.85 ? 'var(--down)' : HUE.blue}
          />
          <RadialGauge
            value={headroom}
            display={pct(headroom * 100, 0)}
            label="Free now"
            caption={`${fmtQuote(snapshot.idle)} idle`}
            color={HUE.teal}
          />
          <RadialGauge
            value={Number.isFinite(coverage) ? Math.min(1, 1 / coverage) : 0}
            display={coverageDisplay}
            label="Payout coverage"
            caption={`owes ≤ ${fmtQuote(maxPayoutAtRisk)}`}
            color={HUE.violet}
          />
        </div>
        <Gauge
          label="Max payout at risk vs pool"
          value={maxPayoutAtRisk}
          max={snapshot.poolValue}
          caption={`${fmtQuote(maxPayoutAtRisk)} / ${fmtQuote(snapshot.poolValue)} ${sym}`}
        />
        <p className="text-[11px] leading-relaxed text-text-3">
          If <span className="text-text-2">every</span> open bet won at once, the pool would owe{' '}
          <span className="font-mono tabular-nums text-text-1">
            {fmtQuote(maxPayoutAtRisk)} {sym}
          </span>{' '}
          — {Number.isFinite(coverage) ? `${coverageDisplay} covered` : 'nothing is at risk right now'}.
        </p>
      </div>

      {/* Share-price performance */}
      <div className="glass-card flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between">
          <CardTitle icon={LuTrendingUp} color={HUE.teal}>
            Share price
          </CardTitle>
          <span className="font-mono text-[11px] tabular-nums text-text-3">
            {series.length >= 2 ? (
              <>
                all-time <span className={allTimeChange >= 0 ? 'text-up' : 'text-down'}>{signed(allTimeChange * 100, 3)}%</span>
              </>
            ) : (
              'building history…'
            )}
          </span>
        </div>
        <PerfChart points={series} />
        {latestFlush && (
          <p className="text-[11px] leading-relaxed text-text-3">
            Last vault update {ago(latestFlush.checkpoint_timestamp_ms, now)} — {latestFlush.market_count} markets
            re-valued. The pool is marked at each keeper flush.
          </p>
        )}
      </div>

      {/* Adverse-settlement stress */}
      <div className="glass-card flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <CardTitle icon={LuSlidersHorizontal} color={HUE.coral}>
            Stress test
          </CardTitle>
          <div className="flex items-center gap-1.5">
            <span className="mr-1 text-[10px] uppercase tracking-wider text-text-3">book ×</span>
            {STRESS_STEPS.map((s) => (
              <button
                key={s}
                onClick={() => setAmp(s)}
                className={`rounded-md px-2 py-1 font-mono text-[11px] tabular-nums transition-colors ${
                  amp === s ? 'bg-(--accent-soft) text-up' : 'text-text-3 hover:text-text-1'
                }`}
              >
                {s}×
              </button>
            ))}
            <InfoTip label="Book amplifier">
              The live testnet book is tiny next to a {fmtQuote(snapshot.poolValue)} pool, so ×1
              barely moves. The amplifier scales the at-risk book so the mechanism is visible; ×1
              is strictly live.
            </InfoTip>
          </div>
        </div>

        <p className="text-[12px] leading-relaxed text-text-2">
          Assume{' '}
          <span className="font-mono tabular-nums text-text-1">{pct(adverse * 100, 0)}</span> of open
          bets settle <span className="text-down">against the pool</span> and have to be paid. How does
          the pool hold up?
        </p>

        <input
          type="range"
          min={0}
          max={1}
          step={0.02}
          value={adverse}
          onChange={(e) => setAdverse(parseFloat(e.target.value))}
          aria-label="Share of open bets that win"
          className="accent-[var(--accent)]"
        />

        {stressed && (
          <div className="glass-inset grid grid-cols-2 gap-x-6 gap-y-4 p-4 sm:grid-cols-4">
            <Stat label="Pool pays out" value={`${fmtQuote(stressed.outflow)} ${sym}`} tone="down" />
            <Stat label="Share price after" value={num(stressed.sharePriceAfter, 6)} strong />
            <Stat
              label="Share price change"
              value={signed(stressed.sharePriceChangePct * 100, 3) + '%'}
              tone={stressed.sharePriceChangePct >= 0 ? 'up' : 'down'}
            />
            <Stat
              label="Covered from idle?"
              value={stressed.breachesIdle ? 'Partly — rest waits' : 'Fully'}
              tone={stressed.breachesIdle ? 'down' : 'up'}
              tip="Whether the payout fits inside the idle cash on hand. If it doesn't, the shortfall is covered as markets settle rather than instantly."
            />
          </div>
        )}

        <p className="text-[11px] leading-relaxed text-text-3">
          Worst case — <span className="text-text-2">every</span> open bet wins at {amp}× book —
          the pool pays {fmtQuote(ampMaxPayout)} {sym} and stays{' '}
          <span className={Number.isFinite(ampCoverage) && ampCoverage < 1 ? 'text-down' : 'text-up'}>
            {Number.isFinite(ampCoverage) ? `${num(ampCoverage, ampCoverage >= 100 ? 0 : 1)}× covered` : 'fully covered'}
          </span>
          . Deliberately conservative: it ignores the premiums those bets already paid in, so the
          real pool is sturdier than this shows.
        </p>
      </div>

      {/* Per-market exposure */}
      <div className="glass-card flex flex-col gap-3 p-5">
        <CardTitle icon={LuLayers} color={HUE.blue}>
          Where the exposure sits
        </CardTitle>
        {exposures.length === 0 ? (
          <p className="text-[12px] leading-relaxed text-text-2">
            No open bets against the pool right now — nothing at risk.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] font-mono text-[12px] tabular-nums">
              <thead>
                <tr className="border-b border-line text-left text-[10px] uppercase tracking-wider text-text-3">
                  <Th>Market</Th>
                  <Th>Settles in</Th>
                  <Th right>Open bets</Th>
                  <Th right>Max payout</Th>
                  <Th right>Share of book</Th>
                </tr>
              </thead>
              <tbody>
                {exposures.map((e) => (
                  <tr key={e.marketId} className="border-b border-line/60 last:border-0">
                    <Td>
                      <a
                        href={OBJECT_EXPLORER(e.marketId)}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1.5 text-text-2 hover:text-accent hover:underline"
                      >
                        <LuHexagon size={12} />
                        {shortId(e.marketId)}
                      </a>
                    </Td>
                    <Td>
                      <span className="text-text-2">{e.expiry > now ? countdown(e.expiry, now) : 'settling'}</span>
                    </Td>
                    <Td right>{e.orders}</Td>
                    <Td right>
                      <span className="text-text-1">{fmtQuote(e.maxPayout)}</span>{' '}
                      <span className="text-text-3">{sym}</span>
                    </Td>
                    <Td right>
                      <span className="inline-flex items-center justify-end gap-2">
                        <span className="hidden h-1.5 w-16 overflow-hidden rounded-full bg-white/[0.06] sm:inline-block">
                          <span className="block h-full rounded-full bg-accent/70" style={{ width: `${e.share * 100}%` }} />
                        </span>
                        <span className="text-text-2">{pct(e.share * 100, 1)}</span>
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </main>
  );
}

function Fig({
  label,
  value,
  base,
  sub,
  info,
}: {
  label: string;
  value: string;
  /** Raw amount — when set, shows a compact form (e.g. 9.59M) on mobile so a big
   *  figure never overflows the half-width card; the full value shows from sm up. */
  base?: number;
  sub: string;
  info?: React.ReactNode;
}) {
  return (
    <div className="glass-inset flex min-w-0 flex-col gap-2 p-4">
      <div className="flex items-center gap-2">
        <span className="eyebrow">{label}</span>
        {info && <InfoTip label={label}>{info}</InfoTip>}
      </div>
      <span className="text-[16px] leading-none tracking-tight text-text-1 sm:text-[20px]">
        {base != null ? (
          <>
            <span className="sm:hidden">{compact(base)}</span>
            <span className="hidden sm:inline">{value}</span>
          </>
        ) : (
          value
        )}
      </span>
      <span className="text-[10px] uppercase tracking-[0.12em] text-text-3">{sub}</span>
    </div>
  );
}

function Stat({
  label,
  value,
  strong,
  tone,
  tip,
}: {
  label: string;
  value: string;
  strong?: boolean;
  tone?: 'up' | 'down';
  tip?: string;
}) {
  const color = tone === 'up' ? 'text-up' : tone === 'down' ? 'text-down' : strong ? 'text-text-1' : 'text-text-2';
  return (
    <div className="flex flex-col gap-1">
      <span className="flex items-center gap-1">
        <span className="text-[10px] uppercase tracking-wider text-text-3">{label}</span>
        {tip && <InfoTip label={label}>{tip}</InfoTip>}
      </span>
      <span className={`font-mono tabular-nums ${strong ? 'text-[15px]' : 'text-[13px]'} ${color}`}>{value}</span>
    </div>
  );
}

function CardTitle({ icon, color, children }: { icon: IconType; color: string; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2.5">
      <IconChip icon={icon} color={color} size={24} />
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-2">{children}</span>
    </h2>
  );
}

function Th({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <th className={`py-2 font-normal ${right ? 'text-right' : ''}`}>{children}</th>;
}

function Td({ children, right }: { children?: React.ReactNode; right?: boolean }) {
  return <td className={`py-2.5 ${right ? 'text-right' : ''}`}>{children}</td>;
}

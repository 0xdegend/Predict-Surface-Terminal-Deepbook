'use client';

/**
 * PositioningFlow — the WIDER options market: max-pain + put/call by expiry, spot ETF
 * net flow, crowd long/short + funding, and 24h liquidations. Every figure is real
 * (Clawby PRO); nothing is invented — in particular there is no Deribit IV bar,
 * because no IV feed exists.
 *
 * IT NO LONGER CLAIMS TO PRICE OUR MARKETS. Every figure here moves on a scale of days
 * to weeks: a max-pain pin for a monthly expiry, a day of ETF flow, a 24h liquidation
 * total. The page's own markets settle in minutes. The panel used to sit at the top of
 * the Context tab at full weight and close with a sentence that put Deribit's monthly
 * pin and our five-minute distribution in the same breath, which invited a reader to
 * treat one as evidence about the other. It was the most misleading line on the page.
 *
 * So `relevance` (from `outsideContext`, driven by time to expiry) now decides how this
 * is framed, and the screen hides it outright on the short tenors:
 *
 *   'primary'  — 1d / 1w markets. Same horizon, so it reads as a real input.
 *   'backdrop' — hourly. Shown, labelled as backdrop, cross-market line suppressed.
 *
 * The cross-market sentence only survives at 'primary', where the two horizons
 * genuinely are comparable. Our own book has taken over the top of the tab (see
 * `OurBook`), which is what should have been answering "the why behind the odds" all
 * along.
 *
 * Hidden entirely until the positioning payload is available.
 */
import type { ReactNode } from 'react';
import { compact, signed } from '@/lib/format';
import { positioningVerdict, type Positioning, type MarketIntel } from '@/lib/insights';
import { Term } from './vocab';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';

const usd = (v: number) => `$${compact(Math.abs(v))}`;
const shortDate = (d: string) => {
  const t = Date.parse(d);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : d;
};

export function PositioningFlow({
  positioning,
  insights,
  intel,
  relevance = 'primary',
}: {
  positioning: Positioning | null;
  insights: BtcInsights | null;
  intel: MarketIntel;
  /** How much this horizon has to say about the market on screen. */
  relevance?: 'primary' | 'backdrop';
}) {
  if (!positioning || !positioning.available) return null;

  const fundingPct = insights?.funding.binancePct ?? insights?.funding.avgPct ?? null;
  const verdict = positioningVerdict(positioning, fundingPct);
  const liq = insights?.liq24h ?? null;
  const liqTotal = liq && liq.longUsd != null && liq.shortUsd != null ? liq.longUsd + liq.shortUsd : null;

  const pin = positioning.maxPain[0]?.maxPainPrice ?? null;
  const share = positioning.options?.deribitSharePct ?? null;
  const upChance = intel.expiries[0]?.upChance ?? null;
  // Only where the horizons actually match. At 'backdrop' this sentence would be
  // comparing a monthly pin to a distribution measured in minutes.
  const cross =
    relevance === 'primary' && pin != null && upChance != null
      ? `The options market is pinned near $${compact(pin)}${share != null ? `, and Deribit carries about ${share.toFixed(0)}% of all BTC options` : ''}. Our live surface puts the chance BTC finishes above the price at ${(upChance * 100).toFixed(0)}%.`
      : null;

  return (
    <section>
      <div className="mb-3 mt-1 flex items-center gap-2.5">
        <h2 className="text-[14px] font-semibold text-text-1">The wider market</h2>
        <span className="text-[10.5px] uppercase tracking-wide text-text-3">
          {relevance === 'primary' ? 'same horizon as this expiry · Clawby PRO' : 'days-to-weeks backdrop, not this expiry · Clawby PRO'}
        </span>
        <span className="h-px flex-1 bg-gradient-to-r from-line to-transparent" />
      </div>

      <div className="glass rounded-lg p-4">
        {verdict && (
          <p className="glass-accent mb-4 rounded-md px-3.5 py-3 text-[13px] leading-relaxed text-text-1">{verdict}</p>
        )}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {/* Max pain + put/call by expiry */}
          <Cell label={<Term plain="Where options pin · put/call" pro="Max pain · put/call" />}>
            <div className="flex flex-col gap-1.5">
              {positioning.maxPain.slice(0, 3).map((e) => (
                <div key={e.date} className="grid grid-cols-[1fr_auto_auto] items-center gap-2 font-mono text-[11.5px]">
                  <span className="text-text-2">{shortDate(e.date)}</span>
                  <span className="text-right tabular-nums text-text-1">${compact(e.maxPainPrice)}</span>
                  <PcrBadge pcr={e.putCallRatio} />
                </div>
              ))}
            </div>
            <Sub>
              <Term plain="Under 1.0 = more up-bets than down. Deribit book." pro="P/C < 1 = call-heavy. Deribit." />
            </Sub>
          </Cell>

          {/* ETF net flow */}
          <Cell label={<Term plain="Institutions bought / sold" pro="Spot ETF net flow · 1d" />}>
            {positioning.etfFlow ? (
              <>
                <div className={`font-mono text-[21px] tabular-nums ${positioning.etfFlow.netUsd >= 0 ? 'text-up' : 'text-down'}`}>
                  {positioning.etfFlow.netUsd >= 0 ? '+' : '−'}
                  {usd(positioning.etfFlow.netUsd)}
                </div>
                <div className="flex flex-col gap-1">
                  {positioning.etfFlow.byFund.map((f) => (
                    <div key={f.ticker} className="flex justify-between font-mono text-[11px]">
                      <span className="text-text-2">{f.ticker}</span>
                      <span className={`tabular-nums ${f.flowUsd >= 0 ? 'text-up' : 'text-down'}`}>
                        {f.flowUsd >= 0 ? '+' : '−'}
                        {usd(f.flowUsd)}
                      </span>
                    </div>
                  ))}
                </div>
                <Sub>Net across spot ETFs{positioning.etfFlow.asOfDate ? ` · ${shortDate(positioning.etfFlow.asOfDate)}` : ''}</Sub>
              </>
            ) : (
              <Empty />
            )}
          </Cell>

          {/* Crowd long/short + funding */}
          <Cell label={<Term plain="Crowd leaning long / short" pro="Long/short + funding" />}>
            {positioning.crowd ? (
              <>
                <Split a={positioning.crowd.longPct} b={positioning.crowd.shortPct} />
                <div className="flex justify-between font-mono text-[10.5px]">
                  <span className="text-up">{positioning.crowd.longPct.toFixed(0)}% long</span>
                  <span className="text-down">{positioning.crowd.shortPct.toFixed(0)}% short</span>
                </div>
                {fundingPct != null && (
                  <Sub>
                    <Term plain="Cost to hold a long: " pro="Funding: " />
                    <b className={`font-mono ${fundingPct >= 0 ? 'text-up' : 'text-down'}`}>{signed(fundingPct, 3)}%</b> / 8h
                  </Sub>
                )}
              </>
            ) : (
              <Empty />
            )}
          </Cell>

          {/* 24h liquidations */}
          <Cell label={<Term plain="Bets wiped out · 24h" pro="24h liquidations" />}>
            {liq && liq.longUsd != null && liq.shortUsd != null && liqTotal != null && liqTotal > 0 ? (
              <>
                <div className="font-mono text-[21px] tabular-nums text-text-1">${compact(liqTotal)}</div>
                <Split a={(liq.longUsd / liqTotal) * 100} b={(liq.shortUsd / liqTotal) * 100} />
                <div className="flex justify-between font-mono text-[10.5px]">
                  <span className="text-up">{usd(liq.longUsd)} longs</span>
                  <span className="text-down">{usd(liq.shortUsd)} shorts</span>
                </div>
                <Sub>{liq.shortUsd > liq.longUsd ? 'More shorts wiped = upward squeeze.' : 'More longs wiped = downward squeeze.'}</Sub>
              </>
            ) : (
              <Empty />
            )}
          </Cell>
        </div>

        {cross && <p className="glass-divider-top mt-4 pt-3 text-[12.5px] leading-relaxed text-text-2">{cross}</p>}
      </div>
    </section>
  );
}

function Cell({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="glass-inset flex flex-col gap-2.5 p-3.5">
      <div className="text-[10.5px] uppercase tracking-wide text-text-3">{label}</div>
      {children}
    </div>
  );
}

function Sub({ children }: { children: ReactNode }) {
  return <div className="mt-auto text-[11px] leading-snug text-text-3">{children}</div>;
}

function Empty() {
  return <div className="text-[12px] text-text-3">No data right now.</div>;
}

function PcrBadge({ pcr }: { pcr: number }) {
  if (!(pcr > 0)) return <span className="text-right text-text-3">—</span>;
  const callHeavy = pcr < 1;
  return (
    <span
      className={`rounded px-1.5 py-px text-center text-[10.5px] tabular-nums ${
        callHeavy ? 'bg-(--accent-soft) text-accent' : 'bg-down/10 text-down'
      }`}
    >
      {pcr.toFixed(2)}
    </span>
  );
}

function Split({ a, b }: { a: number; b: number }) {
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-white/5">
      <span className="bg-up/70" style={{ width: `${a}%` }} />
      <span className="bg-down/70" style={{ width: `${b}%` }} />
    </div>
  );
}

import { describe, it, expect } from 'vitest';
import { buildMarketRead } from './market-read';
import type { BtcInsights } from '@/lib/hooks/use-btc-insights';
import type { StrikeAnalysis } from './strike-analysis';

function ctx(over: Partial<BtcInsights> = {}): BtcInsights {
  return {
    available: true,
    asOf: Date.now(),
    spot: 64_000,
    change24hPct: 1.2,
    oiUsd: 48e9,
    funding: { binancePct: 0.007, avgPct: 0.005 },
    liq24h: { totalUsd: 30e6, longUsd: 12e6, shortUsd: 18e6 },
    maxPain: { strike: 64_000, date: '2026-07-21' },
    sentiment: { value: 30, label: 'Fear' },
    ...over,
  };
}

function strike(over: Partial<StrikeAnalysis> = {}): StrikeAnalysis {
  return {
    requiredMovePct: 0.14,
    requiredMoveUsd: 90,
    sigmaMove: 0.5,
    realizedVolPct: 40,
    empirical: { prob: 0.38, samples: 1800, horizonBars: 4 },
    implied: 0.42,
    edgePts: 4,
    ...over,
  };
}

describe('buildMarketRead', () => {
  it('returns null without usable context', () => {
    expect(buildMarketRead({ ctx: null, strike: null, isUp: true, strikePrice: null, spot: null })).toBeNull();
    expect(
      buildMarketRead({ ctx: ctx({ available: false }), strike: null, isUp: true, strikePrice: null, spot: 64_000 }),
    ).toBeNull();
  });

  it('describes the market on its own when no strike is picked', () => {
    const r = buildMarketRead({ ctx: ctx(), strike: null, isUp: true, strikePrice: null, spot: 64_000 })!;
    expect(r.source).toBe('rules');
    // No "your bet" framing without a bet.
    expect(r.headline.toLowerCase()).not.toContain('your way');
    expect(r.lines.length).toBeGreaterThanOrEqual(2);
    // Every line is non-empty plain text.
    for (const l of r.lines) expect(l.text.length).toBeGreaterThan(10);
  });

  it('leads with the strike sentence once a bet is set', () => {
    const r = buildMarketRead({ ctx: ctx(), strike: strike(), isUp: true, strikePrice: 64_090, spot: 64_000, timeLeftLabel: '4 min' })!;
    expect(r.lines[0].text).toContain('$64,090');
    expect(r.lines[0].text).toContain('4 min');
    expect(r.lines[0].text).toContain('38%'); // happened lately
    expect(r.lines[0].text).toContain('42%'); // surface price
  });

  it('flags a rich strike as a down-tone line', () => {
    const r = buildMarketRead({ ctx: ctx(), strike: strike({ edgePts: 8 }), isUp: true, strikePrice: 64_090, spot: 64_000 })!;
    expect(r.lines[0].tone).toBe('down');
  });

  it('flags a cheap strike as an up-tone line', () => {
    const r = buildMarketRead({ ctx: ctx(), strike: strike({ edgePts: -8 }), isUp: true, strikePrice: 63_900, spot: 64_000 })!;
    expect(r.lines[0].tone).toBe('up');
  });

  it('reads a bullish tape as aligned with an UP bet and against a DOWN bet', () => {
    const bull = ctx({ change24hPct: 2.5, sentiment: { value: 70, label: 'Greed' }, liq24h: { totalUsd: 30e6, longUsd: 8e6, shortUsd: 22e6 } });
    const up = buildMarketRead({ ctx: bull, strike: strike(), isUp: true, strikePrice: 64_090, spot: 64_000 })!;
    const down = buildMarketRead({ ctx: bull, strike: strike(), isUp: false, strikePrice: 63_900, spot: 64_000 })!;
    expect(up.stance).toBe('aligned');
    expect(down.stance).toBe('against');
    expect(up.headline).toContain('your way');
  });

  it('calls a conflicted tape mixed', () => {
    const flat = ctx({ change24hPct: 0.05, sentiment: { value: 50, label: 'Neutral' }, liq24h: { totalUsd: 20e6, longUsd: 10e6, shortUsd: 10e6 } });
    const r = buildMarketRead({ ctx: flat, strike: strike(), isUp: true, strikePrice: 64_090, spot: 64_000 })!;
    expect(r.stance).toBe('mixed');
  });

  it('reads short-heavy liquidations as upward pressure', () => {
    const r = buildMarketRead({
      ctx: ctx({ liq24h: { totalUsd: 30e6, longUsd: 5e6, shortUsd: 25e6 } }),
      strike: null,
      isUp: true,
      strikePrice: null,
      spot: 64_000,
    })!;
    const liq = r.lines.find((l) => l.text.toLowerCase().includes('liquidat'))!;
    expect(liq.text).toContain('upward');
    expect(liq.tone).toBe('up');
  });

  it('never emits jargon a first-timer would trip on', () => {
    const r = buildMarketRead({ ctx: ctx(), strike: strike(), isUp: true, strikePrice: 64_090, spot: 64_000, timeLeftLabel: '4 min' })!;
    const all = (r.headline + ' ' + r.lines.map((l) => l.text).join(' ')).toLowerCase();
    for (const banned of ['edge', 'basis point', 'sigma', 'implied vol', 'skew', 'delta', 'gamma']) {
      expect(all).not.toContain(banned);
    }
  });

  it('degrades cleanly when context is sparse', () => {
    const sparse: BtcInsights = {
      available: true,
      asOf: Date.now(),
      spot: null,
      change24hPct: null,
      oiUsd: null,
      funding: { binancePct: null, avgPct: null },
      liq24h: { totalUsd: null, longUsd: null, shortUsd: null },
      maxPain: null,
      sentiment: { value: 40, label: 'Fear' },
    };
    const r = buildMarketRead({ ctx: sparse, strike: null, isUp: true, strikePrice: null, spot: null });
    // Only the sentiment line survives — still a valid read, not a crash.
    expect(r).not.toBeNull();
    expect(r!.lines.length).toBe(1);
  });
});

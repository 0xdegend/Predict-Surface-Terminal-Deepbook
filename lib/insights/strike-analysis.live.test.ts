/**
 * Sanity check of the strike analysis against the REAL candle tape (§6.5 in
 * spirit: prove the math holds on live data, not just synthetic walks).
 * Network-gated — needs the dev server up, and runs only with RUN_LIVE_INSIGHTS=1:
 *
 *   RUN_LIVE_INSIGHTS=1 npx vitest run lib/insights/strike-analysis.live.test.ts
 *
 * Reuses the real route and the real module — no duplicated fetching or math.
 */
import { describe, it, expect } from 'vitest';
import { analyzeStrike, realizedVol } from './strike-analysis';

const RUN = process.env.RUN_LIVE_INSIGHTS === '1';
const BASE = process.env.INSIGHTS_BASE ?? 'http://localhost:3000';

describe.runIf(RUN)('strike analysis on the live tape', () => {
  it('produces a coherent read across a strike ladder', async () => {
    const res = await fetch(`${BASE}/api/insights/btc/candles`);
    const tape = (await res.json()) as { available: boolean; closes: number[]; times: number[] };
    expect(tape.available).toBe(true);
    expect(tape.closes.length).toBeGreaterThan(500);

    const spot = tape.closes[tape.closes.length - 1];
    const vol = realizedVol(tape.closes);
    // BTC annualized vol lives roughly in the 15%–200% band; outside that,
    // something is wrong with the tape (wrong units, reversed order, gaps).
    expect(vol).toBeGreaterThan(0.15);
    expect(vol).toBeLessThan(2.0);

    const horizon = 5; // minutes
    const rows = [-0.4, -0.2, -0.05, 0, 0.05, 0.2, 0.4].map((pct) => {
      const strike = spot * (1 + pct / 100);
      const a = analyzeStrike({ closes: tape.closes, spot, strike, isUp: true, minutesToExpiry: horizon })!;
      return { pct, prob: a.empirical!.prob, sigma: a.sigmaMove };
    });

    // Print the ladder so a human can eyeball it alongside the assertions.
    console.table(
      rows.map((r) => ({
        move: `${r.pct >= 0 ? '+' : ''}${r.pct}%`,
        'UP wins': `${(r.prob * 100).toFixed(1)}%`,
        sigma: r.sigma.toFixed(2),
      })),
    );

    // The empirical UP rate must fall monotonically as the strike rises: a
    // higher bar cannot be easier to clear. This is the same no-arbitrage
    // monotonicity the surface guarantees, arrived at from realized data.
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].prob).toBeLessThanOrEqual(rows[i - 1].prob);
    }

    // At the money over a short horizon it should sit near a coin flip.
    const atm = rows.find((r) => r.pct === 0)!;
    expect(atm.prob).toBeGreaterThan(0.35);
    expect(atm.prob).toBeLessThan(0.65);

    // Sigma must be signed like the move and zero at the money.
    expect(rows.find((r) => r.pct === 0)!.sigma).toBeCloseTo(0, 6);
    expect(rows.find((r) => r.pct === 0.4)!.sigma).toBeGreaterThan(0);
    expect(rows.find((r) => r.pct === -0.4)!.sigma).toBeLessThan(0);
  }, 30_000);
});

/**
 * Live check for simple mode's ROUND HISTORY (the results tape). Network-gated —
 * runs only with RUN_LIVE=1:
 *
 *   RUN_LIVE=1 npx vitest run lib/markets/round-history.live.test.ts
 *
 * The tape claims "here is how the last N rounds of this cadence closed", which rests
 * on three things being true of already-expired markets, none of which is obvious:
 *   1. the markets list still RETURNS them for a while after expiry;
 *   2. their on-chain state still reads, and carries a `settlement`;
 *   3. that state still carries `reference_tick`, so the line the round was judged
 *      against can be priced.
 *
 * Break any one and the tape either empties or, worse, reports outcomes against the
 * wrong line. This proves all three against the live chain.
 */
import { describe, it, expect } from 'vitest';
import { getV2Markets, getV2MarketState } from '@/lib/api/v2/client';
import { recentMarkets, cadenceOf, CADENCE_ORDER } from '@/lib/markets/v2-discovery';
import { pickHistoryRounds, settledOutcome, upCount } from './round-history';

const RUN = process.env.RUN_LIVE === '1';
const d = RUN ? describe : describe.skip;

const LOOKBACK_MS = 3 * 60 * 60_000;
const COUNT = 12;

d('round history (live)', () => {
  it('builds a real tape for every cadence tab, and resolves each mark against its own line', async () => {
    const all = await getV2Markets(200);
    const now = Date.now();
    const recent = recentMarkets(all, LOOKBACK_MS, now);
    const finished = recent.filter((m) => m.expiry <= now);

    const byCadence = new Map<string, number>();
    for (const m of finished) byCadence.set(cadenceOf(m), (byCadence.get(cadenceOf(m)) ?? 0) + 1);
    console.log(`markets=${all.length} recent=${recent.length} finished=${finished.length}`);
    console.log('finished by cadence:', Object.fromEntries(byCadence));
    expect(finished.length).toBeGreaterThan(0);

    // State reads are a devInspect each, so read the union ONCE and share it across the
    // three tabs rather than fanning out per tab.
    const picks = CADENCE_ORDER.map((c) => ({ c, ...pickHistoryRounds(recent, c, now, COUNT) }));
    const ids = [...new Set(picks.flatMap((p) => p.picked.map((m) => m.expiry_market_id)))];
    const states = new Map(
      await Promise.all(
        ids.map(async (id) => [id, await getV2MarketState(id).catch(() => null)] as const),
      ),
    );

    for (const { c, picked, from } of picks) {
      const outcomes = picked
        .map((m) => settledOutcome(m, states.get(m.expiry_market_id) ?? null))
        .filter((o) => o != null)
        .sort((a, b) => a.expiry - b.expiry);

      console.log(
        `tab ${c} → showing ${from} · ${outcomes.length}/${picked.length} resolved · ` +
          `${upCount(outcomes)} up · ${outcomes.map((o) => (o.up ? '▲' : '▼')).join('')}`,
      );

      // Every tab must land on SOMETHING — the hourly one only via the fallback, which
      // is the whole reason the fallback exists.
      expect(outcomes.length).toBeGreaterThan(0);
      // A mark is only ever drawn from a real line and a real settlement.
      for (const o of outcomes) {
        expect(o.line).toBeGreaterThan(0);
        expect(o.settlement).toBeGreaterThan(0);
        expect(o.up).toBe(o.settlement >= o.line);
      }
    }

    // The rounds CHAIN: each round's line is the PREVIOUS round's settlement price,
    // snapped to the tick grid. That is a strong end-to-end check on the whole join —
    // reading the wrong field, or pricing `reference_tick` as a price instead of a tick
    // INDEX, breaks it immediately. Tolerance is one tick ($0.01 on the live 1m grid),
    // not one cent, because the snap is exactly where the two legitimately differ.
    const oneMin = picks.find((p) => p.from === '1m')!;
    const chain = oneMin.picked
      .map((m) => settledOutcome(m, states.get(m.expiry_market_id) ?? null))
      .filter((o) => o != null)
      .sort((a, b) => a.expiry - b.expiry);
    let chained = 0;
    for (let i = 1; i < chain.length; i++) {
      if (chain[i].expiry - chain[i - 1].expiry !== 60_000) continue; // skip a gap in the walk
      const drift = Math.abs(chain[i].line - chain[i - 1].settlement);
      expect(drift, `round ${i} line ${chain[i].line} vs previous close ${chain[i - 1].settlement}`).toBeLessThan(0.011);
      chained++;
    }
    console.log(`chained ${chained} consecutive rounds: line == previous close, to the tick`);
    expect(chained).toBeGreaterThan(0);
  }, 180_000);
});

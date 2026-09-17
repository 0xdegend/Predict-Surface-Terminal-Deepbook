/**
 * lib/leaderboard/capture-seed.live.test.ts — snapshot the OUTGOING deployment's Skew
 * board and per-wallet history, so a redeploy never costs a trader their standing.
 *
 *   env RUN_LIVE=1 CAPTURE_SEED=1 "$(grep '^NEXT_PUBLIC_BUILDER_CODE_ID=' .env)" \
 *     npx vitest run lib/leaderboard/capture-seed.live.test.ts
 *
 * The builder code has to come in on the command line because vitest does not read
 * `.env` the way Next does, and `config/predict.ts` resolves it at module load, so
 * setting it inside the test body would already be too late. Reading it out of `.env`
 * inline keeps one source of truth rather than pasting the id into a second place.
 *
 * WHY THIS IS A TOOL AND NOT A ONE-OFF. The Skew board is recomputed per deployment from
 * that deployment's own on-chain trades, so every Mysten republish resets it to empty.
 * The 6-24 board was rescued by hand with a temporary test that was then deleted; this is
 * the same capture, kept, because it has now been needed twice (6-24 → 8-06, and 8-06 →
 * 8-21) and will be needed on every future republish.
 *
 * TWO INDEPENDENT PATHS, AND THE SEED IS THEIR UNION. Trade counts are a number traders
 * check against their own memory, and a seed is frozen the moment the old deployment
 * dies, so a quiet undercount is permanent. Neither available read is complete on its
 * own, and their blind spots are opposite, which is exactly why both are run:
 *
 *   A. fetchSkewLeaderboardRows — one global newest-first GraphQL walk of every
 *      order-event type, filtered to the builder code. MEASURED on 8-06: it saturates
 *      its 2,000-event ceiling after 4.4 days, so anything older is invisible to it.
 *   B. a per-OWNER fan-out — read each Skew owner's own order history. MEASURED: reaches
 *      23.6 days back for the same wallet and returns identical results at depth 400 and
 *      1200, so it is saturated rather than truncated. Its blind spot is discovery: a
 *      trade sent by a delegated session key whose owner it cannot resolve.
 *
 * So A misses old trades and B misses undiscoverable ones. Critically, NEITHER CAN
 * OVER-COUNT: both filter on exact `builder_code_id` equality, so every row either path
 * produces is real. That is what makes taking the larger of the two per owner correct
 * rather than a fudge. The gate that remains is the one that tests a real failure: path
 * B is re-read at double depth and must return the same counts, because a truncating
 * fan-out would silently shrink the seed.
 *
 *   C. the PREVIOUS snapshot of this same deployment, if one is on disk. Added
 *      2026-09-04 after a re-capture of 8-06 came back with 521 wallets and yet lost 104
 *      that the 8-31 snapshot had (238 trades), every one last active 6 to 8 days
 *      earlier. Discovery is the blind spot: the owner walk reads the newest few hundred
 *      opt-in events, which by then reached six days, and path A reaches four. Nothing
 *      on chain had changed. So the previous seed's owners are fed into the fan-out (so
 *      they are RE-READ at full depth, not frozen), the owner walk is run ten times
 *      deeper than the live board's, and whatever still falls outside every read is
 *      carried from the previous file by the same larger-count-wins rule. A gate then
 *      refuses to write a seed in which any wallet has fewer trades than it had before.
 *
 * SCOPE IS `skew`, NOT `all`. `aggregateV2Leaderboard` hardcodes scope `'all'`, which
 * counts every trade an owner made anywhere on the venue. The live Skew board and the
 * 6-24 seed both count only builder-code-attributed trades. Scoring the fan-out with
 * `'all'` made the two paths look like they disagreed by 119 trades on one wallet, and
 * that was two different questions being compared, not a discrepancy.
 *
 * WHAT IS CAPTURED IS THE LIVE SLICE ONLY. Both paths read raw chain events for THIS
 * deployment, so neither carries the previous deployment's overlay. That matters: the
 * board the API actually serves has the 6-24 carryover already folded in, and seeding
 * from that would count 6-24 twice once both seeds sit on the next deployment.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ACTIVE_V2_DEPLOYMENT, predictV2Config } from '@/config/predict';
import { onchainMarketState, onchainOwnerOrders, onchainSkewOwners } from '@/lib/api/v2/onchain';
import { deriveV2HistoryFromOrders } from '@/lib/portfolio/v2';
import type { PastPrediction } from '@/lib/portfolio/history';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';
import { toFloat } from '@/config/scale';
import { emptyLbState, finalizeRows, foldOrderEvents, type LbState } from './v2-aggregate';
import { kv } from '@/lib/server/kv';
import { fetchSkewEvents, skewRowsFromEvents } from './v2-onchain-events';
import { LEGACY_OWNERS } from './legacy-carryover';
import type { V2LeaderboardRow } from './v2';
import { mergeSeedHistory, mergeSeedRows, seedOwners, type SeedRow } from './seed-merge';

const RUN = process.env.RUN_LIVE === '1' && process.env.CAPTURE_SEED === '1';

/** Deep enough to cover a Skew trader's entire history on a young deployment, while
 *  still bounding a whale that shares the venue with us. */
const OWNER_TX_DEPTH = 400;

/** How many owner reads run at once. Low on purpose: the public endpoint throttles a
 *  wide fan-out, and a throttled read that retries is far cheaper than a wrong seed. */
const FANOUT_CONCURRENCY = 5;

/** How many of the busiest wallets get re-read at triple depth to prove saturation. */
const SATURATION_PROBE = 6;

/** How many builder-code opt-in events the owner walk reads. The live board's 300 is a
 *  request-path budget and reached only ~6 days on 8-06 by 2026-09-04; a capture is a
 *  one-off and can afford to walk the whole stream. */
const OWNER_EVENT_DEPTH = 3000;

/**
 * How long the whole capture may take.
 *
 * It was a flat fifteen minutes, sized against the 8-06 board. The 8-21 capture ran out of
 * it on 2026-09-17 with nothing written: the fan-out is a few hundred wallets read five at
 * a time, each one several round trips deep (owner txs, then session-key discovery, then
 * keeper redeems), against an endpoint that throttles. That is inherently tens of minutes
 * and it grows with every deployment, so the number is now generous and overridable rather
 * than a guess that has to be edited each time. It is still a real ceiling: a capture that
 * hangs should die, not run until someone notices.
 */
const CAPTURE_TIMEOUT_MS = Number(process.env.CAPTURE_TIMEOUT_MS ?? 45 * 60_000);

const lc = (s: string) => s.toLowerCase();

/** A scored board row in the shape a seed file stores. */
function toSeedRow(r: V2LeaderboardRow): SeedRow {
  return {
    owner: r.owner,
    points: r.points,
    volume: r.volume,
    trades: r.trades,
    netPnl: r.netPnl ?? 0,
    skewVolume: r.skewVolume ?? 0,
    skewTrades: r.skewTrades ?? 0,
    lastActiveMs: r.lastActiveMs ?? 0,
  };
}

/** Accept a seed built only from re-reads, losing whatever has scrolled out of both. */
const ALLOW_NO_KV = process.env.CAPTURE_ALLOW_NO_KV === '1';

/**
 * Source C: the retiring deployment's OWN accumulated board, read from the indexer's KV
 * tally rather than re-read from chain.
 *
 * WHY A RE-READ IS NOT ENOUGH, AND NEVER WAS. Both live paths read the chain as it looks
 * NOW, and both are windowed: the global scan saturates after a few days, and the per-owner
 * fan-out reads a bounded tx depth. The tally is not a re-read. It accumulated forward,
 * cycle by cycle, across the whole life of the deployment, so it holds trades that have
 * since fallen out of every window a capture is able to open. Nothing read later can
 * recover them.
 *
 * MEASURED ON 8-21, 2026-09-17. Identical owner sets, 704 rows either way with none unique
 * to one side, so discovery was never the weak part. But the tally carried 1929 trades to
 * the capture's 1151, and 537 of the 704 wallets were richer in it: the founder's own row
 * read 88 trades against the capture's 68, and the busiest wallet 247 against 95. Seeding
 * from the capture alone froze 60% of the board and silently dropped the rest, which is
 * exactly what the first flip to 9-12 put on screen.
 *
 * SAFE AGAINST DOUBLE COUNTING. `finalizeRows` over the persisted state is the RAW slice
 * for this deployment. The carryover overlay is applied by the API route at read time and
 * is never baked into the tally, so folding this in cannot re-add an older seed.
 *
 * The entry is keyed by predict package and kept for a week, so it is readable only while
 * the retired deployment's tally is still warm. That is the real deadline on a cutover
 * capture, and it is why this runs at the flip rather than whenever someone gets to it.
 */
async function liveBoardRows(): Promise<SeedRow[]> {
  const key = `lb:idx:${predictV2Config.packages.predict}`;
  const missing = (why: string): SeedRow[] => {
    if (!ALLOW_NO_KV) {
      throw new Error(
        `${why}\n\nThe live board tally is the only source for trades that have scrolled out of both read ` +
          `windows; without it the seed freezes a fraction of the board and the rest is gone for good. ` +
          `Pass KV_REST_API_URL / KV_REST_API_TOKEN, or set CAPTURE_ALLOW_NO_KV=1 to accept a windowed seed.`,
      );
    }
    console.log(`  live board (KV)  SKIPPED: ${why}`);
    return [];
  };
  if (!kv) return missing('no KV store is configured');
  const persisted = (await kv.get(key)) as { state?: LbState; builtAtMs?: number } | null;
  if (!persisted?.state) return missing(`no tally at ${key} (expired, or the app never ran on this deployment)`);
  const rows = finalizeRows(persisted.state, predictV2Config.builderCodeId, Date.now(), 'skew');
  const built = persisted.builtAtMs ? new Date(persisted.builtAtMs).toISOString() : 'unknown';
  console.log(
    `  live board (KV)  ${rows.length} rows, ${rows.reduce((t, r) => t + r.trades, 0)} trades, built ${built}`,
  );
  return rows.map(toSeedRow);
}


/**
 * Path B: read each Skew owner's own order history and score it with the SAME
 * `finalizeRows(..., 'skew')` the live board uses.
 *
 * The scope matters more than it looks. `aggregateV2Leaderboard` hardcodes scope
 * `'all'`, which counts every trade an owner made anywhere on the venue; the Skew board
 * and the 6-24 seed both count only builder-code-attributed trades. Scoring the fan-out
 * with `'all'` made the two paths disagree by over a hundred trades on one wallet, and
 * that was two different questions being compared, not a chain discrepancy.
 *
 * `extraOwners` closes the other gap: owner discovery runs off the BuilderCodeSet event
 * stream, which is paged and therefore bounded, so a trader who set the code early
 * enough can fall out of it. Path A sees them in the mint events regardless, so its
 * owners are folded in here and nobody is dropped from their own snapshot.
 */
async function readOwners(owners: string[], txDepth: number, label = 'fan-out'): Promise<Map<string, V2OrderEvent[]>> {
  const ordersByOwner = new Map<string, V2OrderEvent[]>();
  const failed: string[] = [];
  // Progress, because this is the long pole and it used to be a silent one. A capture that
  // runs for half an hour with no output is indistinguishable from a capture that has hung,
  // which is how the 2026-09-17 timeout was only understood after it had already failed.
  const started = Date.now();
  let done = 0;
  const step = Math.max(10, Math.floor(owners.length / 20));
  const tick = () => {
    done += 1;
    if (done % step && done !== owners.length) return;
    const secs = Math.round((Date.now() - started) / 1000);
    const eta = done ? Math.round((secs / done) * (owners.length - done)) : 0;
    console.log(`  ${label}: ${done}/${owners.length} owners  ${secs}s elapsed  ~${eta}s left`);
  };

  // Bounded concurrency with per-owner retries, and NO silent catch.
  //
  // This started as `Promise.all(owners.map(o => read(o).catch(() => [])))`, which fired
  // ninety parallel reads at a public endpoint and swallowed whatever came back
  // throttled. The saturation gate caught it: forty-odd wallets read 0 trades on one pass
  // and 1 on the next, which looked like a depth problem and was actually dropped
  // requests. A seed is frozen forever, so a read that fails has to stop the capture,
  // never quietly become a zero.
  const queue = [...owners];
  const worker = async () => {
    for (let o = queue.pop(); o != null; o = queue.pop()) {
      let wait = 500;
      for (let attempt = 0; ; attempt++) {
        try {
          const orders = await onchainOwnerOrders(o, txDepth);
          if (orders.length) ordersByOwner.set(o, orders);
          tick();
          break;
        } catch (err) {
          if (attempt >= 3) {
            failed.push(`${o}: ${err instanceof Error ? err.message : String(err)}`);
            tick();
            break;
          }
          await new Promise((r) => setTimeout(r, wait));
          wait *= 2;
        }
      }
    }
  };
  await Promise.all(Array.from({ length: FANOUT_CONCURRENCY }, worker));
  if (failed.length) throw new Error(`fan-out reads failed:\n  ${failed.join('\n  ')}`);
  return ordersByOwner;
}

/** Score a set of per-owner orders exactly the way the live Skew board does. */
function scoreSkew(ordersByOwner: Map<string, V2OrderEvent[]>): V2LeaderboardRow[] {
  const code = predictV2Config.builderCodeId;
  const state = emptyLbState();
  for (const orders of ordersByOwner.values()) foldOrderEvents(state, orders, code);
  return finalizeRows(state, code, Date.now(), 'skew');
}

async function fanOutRows(
  extraOwners: string[],
  txDepth: number,
): Promise<{ rows: V2LeaderboardRow[]; ordersByOwner: Map<string, V2OrderEvent[]> }> {
  const code = predictV2Config.builderCodeId;
  const discovered = code ? await onchainSkewOwners(code, undefined, OWNER_EVENT_DEPTH) : [];
  const owners = [
    ...new Set(
      [...discovered, ...extraOwners, ...LEGACY_OWNERS, ...predictV2Config.featuredWallets].map(lc),
    ),
  ];
  const ordersByOwner = await readOwners(owners, txDepth);
  return { rows: scoreSkew(ordersByOwner), ordersByOwner };
}

/**
 * A stand-in market map so history rows resolve real strikes.
 *
 * `deriveV2HistoryFromOrders` turns a position's ticks into dollars with the market's
 * `tick_size`, and falls back to 0 when it has no market. The markets themselves are
 * deployment-scoped objects that stop being readable once the deployment is retired,
 * which is the whole reason a seed is self-contained, so they cannot be fetched later.
 * Every enabled cadence on this deployment shares one tick size, so the map is
 * reconstructed from the config plus each market's own newest event as an expiry
 * stand-in. Without this the entire seed reads "$0" in a trader's history tab, which is
 * how the first capture came out.
 */
function syntheticMarkets(ordersByOwner: Iterable<V2OrderEvent[]>): Map<string, V2Market> {
  const ticks = [...new Set(predictV2Config.cadences.map((c) => c.tickSize).filter((t) => t && t !== '0'))];
  if (ticks.length !== 1) {
    throw new Error(`expected one enabled tick size on ${ACTIVE_V2_DEPLOYMENT}, got ${ticks.join(', ')}`);
  }
  const lastSeen = new Map<string, number>();
  for (const orders of ordersByOwner) {
    for (const o of orders) {
      const id = o.expiry_market_id as string | undefined;
      if (!id) continue;
      const t = Number(o.checkpoint_timestamp_ms ?? 0);
      if (t > (lastSeen.get(id) ?? 0)) lastSeen.set(id, t);
    }
  }
  const map = new Map<string, V2Market>();
  for (const [id, expiry] of lastSeen) {
    map.set(id, { expiry_market_id: id, tick_size: ticks[0], expiry } as unknown as V2Market);
  }
  return map;
}

/** How many market reads run at once. Same reasoning as the owner fan-out: a public
 *  endpoint throttles a wide burst, and a throttled read that retries is far cheaper than a
 *  seed that quietly loses a trader's losing bets. */
const MARKET_CONCURRENCY = 8;

/** How long one market read may take before it is treated as failed and retried.
 *
 *  Measured at 48ms per market against a healthy endpoint, so this is ~400x the real cost
 *  and only ever fires on a stall. It exists because the first run with market reads HUNG:
 *  not one of the 1151 reads reported back in forty minutes, while a progress line prints
 *  every 115. `inspectReturns` has no deadline of its own, so a connection that stops
 *  answering parks its worker forever, and eight parked workers are indistinguishable from
 *  slow progress. A read that cannot answer in twenty seconds has to become a retry. */
const MARKET_READ_TIMEOUT_MS = 20_000;

/** A deadline for the whole market phase, not just one read.
 *
 *  The per-read timeout bounds a single stall; this bounds a systemic one. If the endpoint
 *  degrades, every read burns its four attempts and the phase alone would outlast the whole
 *  capture budget. Past this point the remaining markets are marked unreadable instead,
 *  which is the seed's pre-existing behaviour (unreadable = unsettled = no synthesized row),
 *  so the capture degrades to the old, narrower seed rather than dying with nothing written.
 *  The count is printed, so a phase that hit the deadline is never silent. */
const MARKET_PHASE_BUDGET_MS = 8 * 60_000;

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms);
    work.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e as Error); },
    );
  });
}

/**
 * Settlement price per market ($, or null while unsettled), plus each market's REAL expiry
 * and tick size where the object still answers.
 *
 * WHY THE CAPTURE HAS TO DO THIS. `deriveV2HistoryFromOrders` takes a settlements map as
 * its third argument and uses it to recover a SETTLED LOSS that carries no redeem event. A
 * losing binary is worth nothing, so nobody ever redeems it and the owner scan has nothing
 * to join. The live app passes that map (use-v2-history.ts builds it from
 * `useV2MarketStates`), so a trader's history tab has been showing those losses all along.
 * The capture did NOT pass it, and the first 8-21 seed therefore came out narrower than the
 * tab it exists to preserve: the six real wallets were missing 17 settled losses between
 * them, and every carried history would have overstated its owner's win rate.
 *
 * A market that will not answer is recorded as unsettled rather than failing the capture.
 * That is exactly the behaviour the seed already had, so a failed read can only cost a
 * synthesized row, never invent one. It is counted and printed, because a large count means
 * the losses are going missing again and the number is the only way anyone would notice.
 */
async function readMarketStates(
  ids: string[],
  synthetic: Map<string, V2Market>,
): Promise<{ markets: Map<string, V2Market>; settlements: Map<string, number | null>; unreadable: number }> {
  const markets = new Map(synthetic);
  const settlements = new Map<string, number | null>();
  let unreadable = 0;
  const started = Date.now();
  let done = 0;
  const step = Math.max(25, Math.floor(ids.length / 10));
  const deadline = started + MARKET_PHASE_BUDGET_MS;
  const queue = [...ids];
  const worker = async () => {
    for (let id = queue.pop(); id != null; id = queue.pop()) {
      if (Date.now() > deadline) {
        settlements.set(id, null);
        unreadable += 1;
        done += 1;
        continue;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          const st = await withTimeout(onchainMarketState(id), MARKET_READ_TIMEOUT_MS, `market ${id.slice(0, 10)}`);
          // The real object beats the stand-in: a synthesized loss takes its `settledAt`
          // from the market's expiry, and the stand-in's expiry is only the newest event
          // seen for it, which for a never-redeemed position is the mint itself.
          if (st.market?.expiry) markets.set(id, st.market);
          const sp = st.settlement?.settlement_price;
          settlements.set(id, sp != null ? toFloat(sp) : null);
          break;
        } catch {
          if (attempt >= 3) {
            settlements.set(id, null);
            unreadable += 1;
            break;
          }
          await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
        }
      }
      done += 1;
      if (done % step === 0 || done === ids.length) {
        console.log(`  markets: ${done}/${ids.length} read  ${Math.round((Date.now() - started) / 1000)}s elapsed`);
      }
    }
  };
  await Promise.all(Array.from({ length: MARKET_CONCURRENCY }, worker));
  return { markets, settlements, unreadable };
}

/**
 * Redeems in this set whose MINT is not in it.
 *
 * A position's ticks live on its mint; no redeem event carries them (verified against the
 * live structs on 8-21 and 9-12). So a redeem whose mint fell outside the per-owner read
 * window cannot be turned into a strike, and `deriveV2HistoryFromOrders` yields strike 0
 * rather than failing. Those rows are dropped rather than carried, because a history tab
 * showing a "$0" bet states something untrue.
 *
 * Counting them is what separates the two reasons a row can be unpriceable: an orphaned
 * redeem, which is expected and grows as a deployment ages past the window, and a broken
 * market map, which would zero the WHOLE seed. Only the second is a bug.
 */
function orphanRedeems(orders: V2OrderEvent[]): number {
  const minted = new Set<string>();
  for (const o of orders) {
    if (o.kind === 'order_minted' && o.position_root_id != null) minted.add(String(o.position_root_id));
  }
  let n = 0;
  for (const o of orders) {
    if (!/redeemed/i.test(String(o.kind ?? ''))) continue;
    if (o.position_root_id == null || !minted.has(String(o.position_root_id))) n += 1;
  }
  return n;
}

/** Source C: the seed already on disk for THIS deployment, if any. */
function previousSeed(root: string): { rows: SeedRow[]; byOwner: Record<string, PastPrediction[]>; capturedAt: string } | null {
  const p = resolve(root, `lib/leaderboard/legacy-points-${ACTIVE_V2_DEPLOYMENT}.json`);
  const h = resolve(root, `lib/portfolio/legacy-history-${ACTIVE_V2_DEPLOYMENT}.json`);
  if (!existsSync(p) || !existsSync(h)) return null;
  const points = JSON.parse(readFileSync(p, 'utf8')) as { deployment: string; capturedAt: string; rows: SeedRow[] };
  const history = JSON.parse(readFileSync(h, 'utf8')) as { deployment: string; byOwner: Record<string, PastPrediction[]> };
  if (points.deployment !== ACTIVE_V2_DEPLOYMENT || history.deployment !== ACTIVE_V2_DEPLOYMENT) return null;
  return { rows: points.rows, byOwner: history.byOwner, capturedAt: points.capturedAt };
}

describe.skipIf(!RUN)(`capture the ${ACTIVE_V2_DEPLOYMENT} seed`, () => {
  it('agrees across both read paths, then writes the points + history seeds', async () => {
    expect(predictV2Config.builderCodeId, 'builder code must be wired to attribute Skew trades').not.toBe('');
    const root = resolve(__dirname, '..', '..');
    const prev = previousSeed(root);
    // Read FIRST. It needs no chain access, and it is the one source that cannot be
    // reconstructed later, so a missing tally should cost seconds rather than being
    // discovered after a sixteen-minute fan-out.
    const liveRows = await liveBoardRows();

    // Sequential, not Promise.all. Path A alone is a ~160-request burst against the
    // public GraphQL endpoint; running the fan-out alongside it doubles the peak and
    // reliably earns a 429 that costs more time than the sequencing does. Path A also
    // has to finish first so its owners can seed the fan-out's set.
    // Path A is four event streams walked in parallel, and on a busy deployment it is the
    // first several minutes of the run with nothing to show for it. Report each stream's
    // depth as it goes, so a slow endpoint looks slow rather than looking hung.
    const aStart = Date.now();
    console.log('  path A: walking the global order-event stream');
    const seen = new Map<string, number>();
    const scanEvents = await fetchSkewEvents(undefined, ({ struct, page, events }) => {
      if (seen.get(struct) === page) return;
      seen.set(struct, page);
      if (page % 10 === 0) console.log(`    ${struct}: page ${page}, ${events} events`);
    });
    console.log(`  path A: ${scanEvents.length} Skew events in ${Math.round((Date.now() - aStart) / 1000)}s`);
    const scanRows = skewRowsFromEvents(scanEvents);
    // Everyone the previous seed knows is re-read too, at full depth, so a quiet wallet
    // gets its CURRENT count rather than a frozen one.
    const extra = [...scanRows.map((r) => r.owner), ...(prev ? seedOwners(prev.rows) : [])];
    const fan = await fanOutRows(extra, OWNER_TX_DEPTH);

    const byOwnerScan = new Map(scanRows.map((r) => [lc(r.owner), r]));
    const byOwnerFan = new Map(fan.rows.map((r) => [lc(r.owner), r]));

    // GATE: the fan-out must be saturated, i.e. reading deeper must not find more.
    //
    // Only the heaviest wallets are re-read. A per-owner window can only truncate an
    // owner who fills it, so a wallet with one trade cannot be hiding a second one
    // behind a 400-transaction horizon, and re-reading all ninety of them at triple
    // depth costs minutes to prove something about wallets that were never at risk.
    const heaviest = [...fan.ordersByOwner.entries()]
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, SATURATION_PROBE)
      .map(([o]) => o);
    const deepOrders = await readOwners(heaviest, OWNER_TX_DEPTH * 3);
    const deepRows = new Map(scoreSkew(deepOrders).map((r) => [lc(r.owner), r]));
    const truncated = heaviest.flatMap((o) => {
      const shallow = byOwnerFan.get(o)?.trades ?? 0;
      const deeper = deepRows.get(o)?.trades ?? 0;
      return deeper > shallow ? [`${o}: depth ${OWNER_TX_DEPTH}=${shallow} depth ${OWNER_TX_DEPTH * 3}=${deeper}`] : [];
    });
    /**
     * What truncation costs depends on whether the tally is there.
     *
     * Without it the fan-out IS a board source, so a truncated read silently understates a
     * wallet's standing and the capture must stop. With it the board is bounded below by
     * the tally (asserted after the merge), and truncation can no longer cost anyone
     * points, volume or trades. What it still costs is HISTORY rows, which are derived from
     * these same per-owner reads and have no second source, so it stays loud.
     *
     * Raising the depth is not the fix it looks like. On 8-21 the founder's wallet read 57
     * trades at depth 400 and 68 at 1200, while the tally holds 88: the older trades are
     * past any depth worth paying for across a thousand wallets, because the tally
     * accumulated them live and a re-read simply cannot go back that far.
     */
    if (liveRows.length) {
      if (truncated.length) {
        console.log(
          `\n  NOTE: fan-out truncating for ${truncated.length} of the busiest wallets. Standing is safe ` +
            `(the tally backs the board); their HISTORY is short by the trades past the window:\n    ` +
            truncated.join('\n    '),
        );
      }
    } else {
      expect(truncated, `fan-out is truncating, raise OWNER_TX_DEPTH:\n  ${truncated.join('\n  ')}`).toEqual([]);
    }

    // Union, per owner, larger count wins. Whole rows rather than field-wise maxima, so
    // points / volume / PnL always come from one coherent read of one trader.
    const owners = [...new Set([...byOwnerScan.keys(), ...byOwnerFan.keys()])];
    let fromScan = 0;
    let fromFan = 0;
    const rows = owners
      .map((o) => {
        const a = byOwnerScan.get(o);
        const b = byOwnerFan.get(o);
        if (a && b) {
          if (a.trades > b.trades) fromScan++;
          else fromFan++;
          return a.trades > b.trades ? a : b;
        }
        if (a) fromScan++;
        else fromFan++;
        return (a ?? b)!;
      })
      .filter((r) => r.trades > 0)
      .sort((x, y) => y.points - x.points);

    console.log(`\n  deployment       ${ACTIVE_V2_DEPLOYMENT}`);
    console.log(`  builder code     ${predictV2Config.builderCodeId.slice(0, 14)}…`);
    console.log(`  path A (scan)    ${scanRows.length} rows, ${scanRows.reduce((s2, r) => s2 + r.trades, 0)} trades`);
    console.log(`  path B (fan-out) ${fan.rows.length} rows, ${fan.rows.reduce((s2, r) => s2 + r.trades, 0)} trades`);
    console.log(`  union            ${rows.length} rows, ${rows.reduce((s2, r) => s2 + r.trades, 0)} trades`);
    console.log(`  won by           scan ${fromScan}, fan-out ${fromFan}\n`);
    console.log('  owner            A.trades  B.trades  kept   points');
    for (const r of rows) {
      const o = lc(r.owner);
      console.log(
        `  ${o.slice(0, 14)}…  ${String(byOwnerScan.get(o)?.trades ?? 0).padStart(8)}` +
          `  ${String(byOwnerFan.get(o)?.trades ?? 0).padStart(8)}  ${String(r.trades).padStart(4)}` +
          `  ${r.points.toFixed(0).padStart(7)}`,
      );
    }

    const capturedAt = new Date().toISOString();
    const freshRows: SeedRow[] = rows.map(toSeedRow);
    // Source C: the deployment's own accumulated board, which reaches past both windows.
    const withLive = mergeSeedRows(liveRows, freshRows);
    // Source D. Whatever this run could not see is carried from the previous file.
    const seedRows = mergeSeedRows(withLive, prev?.rows ?? []);
    const seenNow = new Set(freshRows.map((r) => lc(r.owner)));
    const carriedOnly = seedRows.filter((r) => !seenNow.has(lc(r.owner))).length;
    console.log(
      `  previous seed    ${prev ? `${prev.rows.length} rows from ${prev.capturedAt}` : 'none'}` +
        `; ${carriedOnly} owners carried that neither path saw this run`,
    );

    /**
     * GATE: the seed is never less complete than the board traders were looking at.
     *
     * This is the property the whole capture exists to hold, and until 2026-09-17 nothing
     * checked it. The first 8-21 seed passed every gate there was and still froze 1151 of
     * the board's 1929 trades, because every gate compared the capture against ITSELF: path
     * A against path B, this run against the previous file. Both re-read the chain through
     * the same windows, so both were short by the same trades and agreed with each other
     * perfectly. Nobody noticed until the flip put the shortfall on screen.
     *
     * The tally is the outside check. It is the number the board served, so a seed that
     * falls short of it is by definition losing standing somebody had already earned.
     */
    if (liveRows.length) {
      const seedBy = new Map(seedRows.map((r) => [lc(r.owner), r]));
      const short = liveRows
        .filter((r) => (seedBy.get(lc(r.owner))?.trades ?? 0) < r.trades)
        .map((r) => `${lc(r.owner).slice(0, 14)}… board ${r.trades} → seed ${seedBy.get(lc(r.owner))?.trades ?? 0}`);
      expect(
        short,
        `${short.length} wallets would carry FEWER trades than the live board showed them:\n  ${short.join('\n  ')}`,
      ).toEqual([]);
      const liveTrades = liveRows.reduce((t, r) => t + r.trades, 0);
      const seedTrades = seedRows.reduce((t, r) => t + r.trades, 0);
      console.log(`  vs live board    ${seedTrades} seed trades against ${liveTrades} the board showed`);
    }

    // GATE: nobody loses standing against the previous seed. True by construction of the
    // merge, asserted anyway, because this is the one property a seed must never lose.
    if (prev) {
      const merged = new Map(seedRows.map((r) => [lc(r.owner), r]));
      const lost = prev.rows
        .filter((r) => (merged.get(lc(r.owner))?.trades ?? 0) < r.trades)
        .map((r) => `${lc(r.owner).slice(0, 14)}… ${r.trades} → ${merged.get(lc(r.owner))?.trades ?? 0}`);
      expect(lost, `wallets would lose trades against the previous seed:\n  ${lost.join('\n  ')}`).toEqual([]);
    }

    const pointsSeed = { deployment: ACTIVE_V2_DEPLOYMENT, capturedAt, rows: seedRows };

    // History gets the same union treatment. The fan-out's per-owner orders are the
    // primary source, and any wallet only path A could see is derived from that path's
    // own events instead, so the history tab is not narrower than the board.
    const scanByOwner = new Map<string, V2OrderEvent[]>();
    for (const e of scanEvents) {
      const o = String((e as { owner?: string }).owner ?? '').toLowerCase();
      if (!o) continue;
      const list = scanByOwner.get(o);
      if (list) list.push(e);
      else scanByOwner.set(o, [e]);
    }

    const byOwner: Record<string, PastPrediction[]> = {};
    const allOrders = [...fan.ordersByOwner.values(), ...scanByOwner.values()];
    const marketIds = [
      ...new Set(
        allOrders
          .flat()
          .map((o) => (o.expiry_market_id ? String(o.expiry_market_id) : ''))
          .filter(Boolean),
      ),
    ];
    console.log(`\n  markets          ${marketIds.length} distinct, reading each for settlement`);
    const { markets, settlements, unreadable } = await readMarketStates(marketIds, syntheticMarkets(allOrders));
    let dropped = 0;
    let explained = 0;
    /**
     * A row is only worth carrying if it can say what was bet. A redeem whose mint fell
     * outside the read has no ticks to price, and the deriver returns strike 0 rather
     * than failing, so those rows would render as a "$0" bet in the trader's history
     * forever. Dropping them is the honest outcome: a handful of missing rows beats a
     * handful of rows that state something untrue.
     */
    const priceable = (rows: PastPrediction[]) => {
      const keep = rows.filter((r) => r.strike > 0 || r.band != null);
      dropped += rows.length - keep.length;
      return keep.map((r) => ({ ...r, legacy: true }));
    };
    for (const [owner, orders] of fan.ordersByOwner) {
      explained += orphanRedeems(orders);
      const derived = priceable(deriveV2HistoryFromOrders(orders, markets, settlements));
      if (derived.length) byOwner[owner] = derived;
    }
    for (const [owner, orders] of scanByOwner) {
      if (byOwner[owner]) continue; // the fan-out already has a complete read for them
      explained += orphanRedeems(orders);
      const derived = priceable(deriveV2HistoryFromOrders(orders, markets, settlements));
      if (derived.length) byOwner[owner] = derived;
    }
    const kept = Object.values(byOwner).flat().length;
    const unexplained = Math.max(0, dropped - explained);
    // Losses recovered from settlement rather than from a redeem event. Printed because it
    // is the only visible sign that the settlements map is doing its job: the number went
    // from 0 (the argument was not passed) to the real count.
    const synthesized = Object.values(byOwner)
      .flat()
      .filter((r) => String(r.key).endsWith('-settled-loss')).length;
    console.log(
      `\n  history          ${kept} rows kept, ${dropped} unpriceable dropped ` +
        `(${explained} orphaned redeems, ${unexplained} unexplained)` +
        `\n                   ${synthesized} settled losses recovered from settlement (no redeem exists to join)` +
        `\n                   ${unreadable} of ${marketIds.length} markets would not answer (counted as unsettled)`,
    );

    /**
     * GATE: every dropped row must be a redeem whose mint we could not see.
     *
     * This used to be a flat ratio, under 1% unpriceable. That was a PROXY for the thing
     * it cares about — a broken market map, which zeroes the whole seed, and is how the
     * first capture came out. The proxy fails for the wrong reason as a deployment ages:
     * orphaned redeems accumulate as more mints fall outside the per-owner window, so 8-21
     * tripped it at 3.4% with nothing whatsoever wrong.
     *
     * Testing the property directly is both stricter and more permissive. Stricter because
     * ONE row dropped for a reason we cannot name now fails, where a ratio would have
     * absorbed it. More permissive because a run where every drop is accounted for passes,
     * however many there are. A broken market map produces drops that are not orphans, so
     * it still fails here, and immediately.
     */
    expect(
      unexplained,
      `${unexplained} history rows were dropped for a reason other than a missing mint — ` +
        `suspect the market map (the whole seed would read "$0")`,
    ).toBe(0);

    // Source C for history: union by row key per wallet, fresh copy winning.
    const mergedHistory = prev ? mergeSeedHistory(byOwner, prev.byOwner) : byOwner;
    if (prev) {
      const shrunk = Object.entries(prev.byOwner)
        .filter(([o, rows]) => (mergedHistory[lc(o)]?.length ?? 0) < rows.length)
        .map(([o]) => lc(o).slice(0, 14));
      expect(shrunk, `wallets would lose history rows against the previous seed: ${shrunk.join(', ')}`).toEqual([]);
      const mergedRows = Object.values(mergedHistory).flat().length;
      console.log(`  history merged   ${mergedRows} rows across ${Object.keys(mergedHistory).length} wallets (with the previous seed)`);
    }
    const historySeed = { deployment: ACTIVE_V2_DEPLOYMENT, capturedAt, byOwner: mergedHistory };

    const pointsPath = resolve(root, `lib/leaderboard/legacy-points-${ACTIVE_V2_DEPLOYMENT}.json`);
    const historyPath = resolve(root, `lib/portfolio/legacy-history-${ACTIVE_V2_DEPLOYMENT}.json`);
    writeFileSync(pointsPath, `${JSON.stringify(pointsSeed, null, 2)}\n`);
    writeFileSync(historyPath, `${JSON.stringify(historySeed, null, 2)}\n`);

    console.log(
      `\n  WROTE ${pointsSeed.rows.length} board rows (${pointsSeed.rows.reduce((s, r) => s + r.trades, 0)} trades)` +
        ` + history for ${Object.keys(mergedHistory).length} wallets` +
        `\n    ${pointsPath}\n    ${historyPath}\n`,
    );

    expect(pointsSeed.rows.length).toBeGreaterThan(0);
  }, CAPTURE_TIMEOUT_MS);
});

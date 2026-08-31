/**
 * The end-to-end proof for the 8-21 read layer: our real functions, against the real chain,
 * asserting the things that would be SILENTLY wrong rather than the things that would throw.
 *
 * Every check here is "this is not zero" or "this is not stale", because that is how the
 * republish breaks us. A renamed event field read by name is `undefined`, `Number(undefined)`
 * is 0, and the app renders a complete, confident, entirely wrong page. A typecheck cannot
 * see it, a unit test on invented payloads cannot see it, and a human looking at the UI
 * cannot see it either — a board of $0 stakes looks like a quiet day.
 *
 * Runs only when pointed at 8-21:
 *
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 \
 *     npx vitest run lib/api/v2/onchain-821.live.test.ts
 */
import { describe, it, expect } from 'vitest';
import { predictV2Config, V2_IS_821_PLUS, ACTIVE_V2_DEPLOYMENT } from '@/config/predict';
import { onchainMarkets, onchainMarketState, onchainAllOrders, onchainPythLatest } from './onchain';
import { UNIT_LEVERAGE } from './event-compat';
import { fetchAllOrderEvents } from '@/lib/leaderboard/v2-onchain-events';

const RUN = process.env.RUN_LIVE === '1' && V2_IS_821_PLUS;

describe.skipIf(!RUN)(`the 8-21 read layer against live chain state (${ACTIVE_V2_DEPLOYMENT})`, () => {
  it('reads markets whose numbers survived the MarketCreated reshuffle', async () => {
    const markets = await onchainMarkets(50);
    expect(markets.length, 'no markets — cannot judge the rest').toBeGreaterThan(0);
    const m = markets[0];
    // These four moved position in the struct. Read by name, so a reorder is survivable,
    // but a REMOVED one silently becomes 0 and takes the strike grid with it.
    expect(BigInt(m.tick_size), 'tick_size is 0 — the strike grid would collapse').toBeGreaterThan(0n);
    expect(BigInt(m.admission_tick_size)).toBeGreaterThan(0n);
    expect(m.expiry, 'expiry is 0 — every market would look already settled').toBeGreaterThan(0);
    // Removed from the protocol; the compat seam must present the no-op value, because
    // `toFloat(undefined)` is NaN and NaN in the slider bounds is a broken ticket.
    expect(m.max_admission_leverage).toBe(UNIT_LEVERAGE);
    expect(m.liquidation_ltv).toBe(0);
    console.log(`markets: ${markets.length}, first expiry ${new Date(m.expiry).toISOString()}`);
  }, 90_000);

  it('reads per-market state, the path that named three deleted getters', async () => {
    // This is a simulate of a PTB of view calls. A function that no longer exists does not
    // return 0, it fails to RESOLVE — so before the fix this threw and took every settled
    // position's strike with it, since it is the only reader that works on an expired market.
    const markets = await onchainMarkets(20);
    const state = await onchainMarketState(markets[0].expiry_market_id);
    expect(state.expiry_market_id).toBe(markets[0].expiry_market_id);
    expect(BigInt(state.market.tick_size)).toBeGreaterThan(0n);
    expect(state.market.expiry).toBeGreaterThan(0);
    expect(state.market.max_admission_leverage).toBe(UNIT_LEVERAGE);
    console.log(`state: tick ${state.market.tick_size}, ref ${state.reference_tick}, paused ${state.mint_paused}`);
  }, 90_000);

  it('reads order events with a real stake on them, not a zero one', async () => {
    // The failure this whole phase exists for. `OrderMinted.net_premium` became `premium`;
    // unpatched, every one of these is 0 and the leaderboard ranks everybody on nothing.
    const orders = await onchainAllOrders(200);
    const mints = orders.filter((o) => o.kind === 'order_minted');
    expect(mints.length, 'no mints in the window — cannot judge the stakes').toBeGreaterThan(0);
    const withStake = mints.filter((o) => Number(o.net_premium ?? 0) > 0);
    expect(withStake.length, 'every mint reads as a $0 stake — the compat seam is not applied').toBe(mints.length);
    // The event's own timestamp, renamed to `onchain_timestamp_ms`. Falls back to the
    // indexer stamp, so a miss here is a subtler drift than a 0, but still real.
    const timed = mints.filter((o) => Number(o.minted_at_ms ?? 0) > 0);
    expect(timed.length).toBe(mints.length);
    console.log(`mints: ${mints.length}, all with stake and stamp`);
  }, 120_000);

  it('reads a pyth spot whose timestamp is recent, not epoch zero', async () => {
    // `OracleRead.update_timestamp_ms` became `onchain_timestamp_ms`. Losing it does not
    // blank the price — it makes a perfectly healthy feed look infinitely stale, which
    // fires the stale-feed banner and breaks the chart's live edge.
    const spot = await onchainPythLatest();
    if (!spot) throw new Error('no pyth observation on the 8-21 feed');
    expect(Number(spot.price_magnitude)).toBeGreaterThan(0);
    const stamp = spot.checkpoint_timestamp_ms ?? 0;
    const age = Date.now() - stamp;
    expect(stamp, 'timestamp is 0 — the feed would read as stale forever').toBeGreaterThan(0);
    expect(age, `pyth stamp is ${Math.round(age / 1000)}s old`).toBeLessThan(30 * 60_000);
    console.log(`pyth: ${spot.price_magnitude} e${spot.exponent_magnitude}, ${Math.round(age / 1000)}s old`);
  }, 60_000);

  it('reads the same non-zero stakes through the GraphQL leaderboard path', async () => {
    // A SECOND, independent reader with its own copy of the event-to-row translation.
    // The gRPC path above passing proves nothing about this one, and this is the path that
    // actually builds the board, so it gets its own assertion rather than an assumption.
    // Read UNFILTERED: our builder code is not registered on 8-21 until Phase 6, so the
    // Skew-filtered reader is correctly empty and would prove nothing either way.
    const events = await fetchAllOrderEvents();
    const mints = events.filter((o) => o.kind === 'order_minted');
    expect(mints.length, 'no mints from the GraphQL reader').toBeGreaterThan(0);
    const zeroed = mints.filter((o) => !(Number(o.net_premium ?? 0) > 0));
    expect(zeroed.length, `${zeroed.length}/${mints.length} mints read as a $0 stake`).toBe(0);
    console.log(`graphql mints: ${mints.length}, none zeroed`);
  }, 180_000);

  it('has the sessions config the trade builders now require', async () => {
    // Every session entry point takes it as an argument. Absent, the builders throw by
    // design rather than sending a zero address into an object slot.
    expect(predictV2Config.shared.sessionsConfig).toMatch(/^0x[0-9a-f]{64}$/);
  });
});

/**
 * Pins the shape of the 8-21 deployment block.
 *
 * Config is the one file where a wrong character costs real money and nothing else in
 * the codebase will notice: every id here is an opaque hex string, so a copy-paste that
 * lands an 8-06 object in the 8-21 block typechecks perfectly and then quietly points a
 * mint at the wrong registry. These assertions are the cheap version of noticing.
 *
 * They deliberately test RELATIONSHIPS rather than restating the ids. Repeating each
 * hex string here would only prove the file can be copied, and would need editing on
 * every redeploy, which is exactly when nobody wants a test in the way.
 */
import { describe, it, expect } from 'vitest';
import { ACTIVE_V2_DEPLOYMENT, predictV2Config as c, V2_IS_821_PLUS } from './predict';

describe(`the active deployment block (${ACTIVE_V2_DEPLOYMENT})`, () => {
  it('still defaults to 8-06, so adding 8-21 changed nothing for users', () => {
    // Conditional on the override being ABSENT. The point is that the default did not
    // move, not that nobody may select 8-21 — selecting it deliberately is how every
    // other assertion in this file gets exercised against the new block.
    if (!process.env.NEXT_PUBLIC_PREDICT_DEPLOYMENT) expect(ACTIVE_V2_DEPLOYMENT).toBe('8-06');
    expect(ACTIVE_V2_DEPLOYMENT).not.toBe('7-29');
  });

  it('never lets the predict package and the registry collide', () => {
    // A republish always changes both. A collision means a block was copied and not
    // fully edited, which is the failure this file exists to catch.
    expect(c.packages.predict).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c.shared.registry).toMatch(/^0x[0-9a-f]{64}$/);
    expect(c.packages.predict).not.toBe(c.shared.registry);
  });

  it('derives the PLP coin type from its own predict package', () => {
    // PLP is published BY the predict package, so a block whose plpCoinType still names
    // the previous deployment's package fails on any vault read, and only when someone
    // opens the vault.
    expect(c.plpCoinType).toBe(`${c.packages.predict}::plp::PLP`);
  });

  it('keeps every configured object id well-formed and distinct', () => {
    const ids = [
      ...Object.values(c.packages).filter(Boolean),
      ...Object.values(c.shared).filter(Boolean),
      c.asset.pythFeedId,
      ...c.asset.bsFeedIds,
      c.accumulatorRootId,
    ];
    for (const id of ids) expect(id, `malformed object id: ${id}`).toMatch(/^0x[0-9a-f]{1,64}$/);
    const shared = Object.values(c.shared).filter(Boolean);
    expect(new Set(shared).size, 'duplicate id among shared objects').toBe(shared.length);
  });

  it('pairs the pricer with the right number of block-scholes feeds', () => {
    // `load_live_pricer` takes the pyth feed then the block-scholes feeds in call order.
    // 6-24 passed three; every deployment since passes two. A wrong count aborts at
    // quote time, the least debuggable place for it to surface.
    expect(c.asset.bsFeedIds).toHaveLength(ACTIVE_V2_DEPLOYMENT === '6-24' ? 3 : 2);
    expect(new Set(c.asset.bsFeedIds).size).toBe(c.asset.bsFeedIds.length);
  });

  it('ties the leverage window to whether leverage still exists', () => {
    // 8-21 removed leverage from the protocol, so its window is 0. A deployment that
    // still has leverage needs a real window, or the ticket offers multiples the chain
    // will reject.
    if (V2_IS_821_PLUS) expect(c.noLeverageWindowMs).toBe(0);
    else expect(c.noLeverageWindowMs).toBeGreaterThan(0);
  });

  it('only claims HTTP indexers on a deployment that has them', () => {
    // 7-29 and 8-06 ship none and read on-chain; 8-21 has three. A leftover serverUrl on
    // a deployment without an indexer sends reads to a host that will never answer.
    if (V2_IS_821_PLUS) {
      expect(c.serverUrl).toContain('predict-server-v4');
      expect(c.oracleServerUrl).toContain('propbook-server-v4');
      expect(c.accountServerUrl).toContain('account-server-v4');
    }
  });

  it('carries no cadence that is disabled upstream', () => {
    // A cadence shipped with tickSize 0 is off upstream. Carrying one into config would
    // surface an untradeable market in the picker.
    expect(c.cadences.length).toBeGreaterThan(0);
    for (const cad of c.cadences) {
      expect(BigInt(cad.tickSize), `cadence ${cad.name} has tick 0`).toBeGreaterThan(0n);
      expect(BigInt(cad.admissionTickSize), `cadence ${cad.name} admission tick 0`).toBeGreaterThan(0n);
    }
  });
});

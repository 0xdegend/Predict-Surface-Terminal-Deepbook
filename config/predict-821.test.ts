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
import { ACTIVE_V2_DEPLOYMENT, KNOWN_V2_DEPLOYMENTS, predictV2Config as c, V2_IS_821_PLUS } from './predict';

describe(`the active deployment block (${ACTIVE_V2_DEPLOYMENT})`, () => {
  it('defaults to the NEWEST release, never a retired one', () => {
    // This assertion used to pin the default at 8-06 and call that a feature: adding a
    // deployment block was supposed to change nothing until someone flipped the env var.
    // The cost showed up on 2026-09-17. 8-06's writers had been off for weeks and 8-21's
    // since 9-16, yet the fallback still said '8-06', so any environment missing the env
    // var pointed the whole app at a dead chain: frozen prices, an empty board, aborting
    // mints. It looked like a working app, which is the expensive way to fail.
    //
    // The rule is now the one that stays true: the default IS the newest release we know
    // about. Conditional on the override being absent, because selecting an older block
    // deliberately is how the rest of this file gets exercised.
    const newest = KNOWN_V2_DEPLOYMENTS[KNOWN_V2_DEPLOYMENTS.length - 1];
    if (!process.env.NEXT_PUBLIC_PREDICT_DEPLOYMENT) {
      expect(ACTIVE_V2_DEPLOYMENT, 'the fallback must move with every cutover').toBe(newest);
    }
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
    // A leftover serverUrl on a deployment without an indexer sends reads to a host that
    // will never answer, so this is keyed to the deployment rather than to the shape flag.
    // 7-29, 8-06 and 9-12 ship none and read on chain; 8-21 alone had three, and its three
    // `-v4` hosts stopped resolving once 9-12 replaced it.
    if (ACTIVE_V2_DEPLOYMENT === '8-21') {
      expect(c.serverUrl).toContain('predict-server-v4');
      expect(c.oracleServerUrl).toContain('propbook-server-v4');
      expect(c.accountServerUrl).toContain('account-server-v4');
    } else {
      expect(c.serverUrl).toBe('');
      expect(c.oracleServerUrl).toBe('');
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

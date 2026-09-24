/**
 * The /v2/admin gate. It is UI-only (claiming is enforced on-chain by `assert_owner`),
 * but a wrong list here either serves founder tooling to whoever guessed the URL or locks
 * the team out of its own console, and neither failure shows up in any other test.
 *
 * The admin wallet moved on 2026-09-24, at the founder's call and ahead of the mainnet
 * cutover, from the old deployer key to 0x06a6f0…fa48 — replacing it, not joining it.
 * These assertions exist so the old key cannot creep back in through a revert of the
 * config default.
 */
import { describe, it, expect } from 'vitest';
import { adminAddresses, isAdminAddress } from './predict';

const ADMIN = '0x06a6f0f02ee7883cc37dfc0fd72834559cf008dde1cd7f2ee86e4a65688cfa48';
const OLD_DEPLOYER = '0x33a8c34ae6f4dd41288ddb81c521b3c2a49c251abcc0926fe54c6376757ff3f4';

/** An operator override is a legitimate way to run this app, so the literal assertions
 *  only apply when the list is coming from the config default. */
const usingDefault = !process.env.NEXT_PUBLIC_ADMIN_ADDRESSES;

describe('isAdminAddress', () => {
  it.runIf(usingDefault)('admits the current admin wallet, and only it', () => {
    expect(adminAddresses).toEqual([ADMIN]);
    expect(isAdminAddress(ADMIN)).toBe(true);
  });

  it.runIf(usingDefault)('no longer admits the old deployer key', () => {
    expect(isAdminAddress(OLD_DEPLOYER)).toBe(false);
  });

  it('matches regardless of case, and is false for anything empty', () => {
    const [addr] = adminAddresses;
    expect(isAdminAddress(`0x${addr.slice(2).toUpperCase()}`)).toBe(true);
    expect(isAdminAddress(undefined)).toBe(false);
    expect(isAdminAddress(null)).toBe(false);
    expect(isAdminAddress('')).toBe(false);
    expect(isAdminAddress('0x0')).toBe(false);
  });
});

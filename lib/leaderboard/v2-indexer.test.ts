import { describe, it, expect } from 'vitest';
import { persistDue, withDeadline } from './v2-indexer';

describe('persistDue (the store-write throttle)', () => {
  it('writes right away on a fresh process, then not again inside the window', () => {
    expect(persistDue(1_000, 0, false, 120_000)).toBe(true);
    expect(persistDue(60_000, 1_000, false, 120_000)).toBe(false);
    expect(persistDue(121_000, 1_000, false, 120_000)).toBe(true);
  });

  it('never starts a second write while one is in flight', () => {
    expect(persistDue(500_000, 0, true, 120_000)).toBe(false);
  });
});

describe('withDeadline (the forced-refresh ceiling)', () => {
  it('hands back the value when it arrives in time', async () => {
    await expect(withDeadline(Promise.resolve('fresh'), 50, 'last')).resolves.toBe('fresh');
  });

  it('falls back to the last tally when the scan is slow, without cancelling it', async () => {
    let settled = false;
    const slow = new Promise<string>((r) => setTimeout(() => { settled = true; r('late'); }, 40));
    await expect(withDeadline(slow, 5, 'last')).resolves.toBe('last');
    expect(settled).toBe(false);
    await slow; // the scan still completes on its own
    expect(settled).toBe(true);
  });

  it('falls back when the scan fails', async () => {
    await expect(withDeadline(Promise.reject(new Error('boom')), 50, 'last')).resolves.toBe('last');
  });
});

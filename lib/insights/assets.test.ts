import { describe, it, expect } from 'vitest';
import { getAsset, ASSETS, DEFAULT_ASSET, LIVE_ASSETS } from './assets';

describe('asset registry', () => {
  it('defaults to BTC', () => {
    expect(DEFAULT_ASSET.id).toBe('BTC');
    expect(getAsset(undefined).id).toBe('BTC');
    expect(getAsset(null).id).toBe('BTC');
  });

  it('resolves case-insensitively', () => {
    expect(getAsset('eth').id).toBe('ETH');
    expect(getAsset('ETH').id).toBe('ETH');
    expect(getAsset('Btc').id).toBe('BTC');
  });

  it('falls back to the default on an unknown id (never throws)', () => {
    expect(getAsset('doge').id).toBe('BTC');
    expect(getAsset('').id).toBe('BTC');
  });

  it('only lists live assets for the page', () => {
    expect(LIVE_ASSETS.map((a) => a.id)).toContain('BTC');
    expect(LIVE_ASSETS.every((a) => a.live)).toBe(true);
    expect(ASSETS.ETH.live).toBe(false);
  });
});

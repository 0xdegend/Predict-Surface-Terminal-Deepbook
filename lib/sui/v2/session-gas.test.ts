import { describe, it, expect, vi, afterEach } from 'vitest';
import { dripSessionGas } from './session-gas';

function mockFetch(status: number, body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('dripSessionGas — never throws, maps the route response', () => {
  it('reports ok with the digest + amount on a successful drip', async () => {
    mockFetch(200, { digest: 'abc123', suiAmount: '100000000' });
    const r = await dripSessionGas('0xkey');
    expect(r).toEqual({ ok: true, digest: 'abc123', suiAmount: '100000000', alreadyFunded: undefined });
  });

  it('treats an already-funded key as ok with no tx', async () => {
    mockFetch(200, { digest: null, suiAmount: '0', alreadyFunded: true });
    const r = await dripSessionGas('0xkey');
    expect(r.ok).toBe(true);
    expect(r.alreadyFunded).toBe(true);
    expect(r.digest).toBeNull();
  });

  it('returns ok:false with the server code on a refusal (so the caller can fall back)', async () => {
    mockFetch(503, { error: 'Treasury is low on SUI', code: 'treasury_empty' });
    const r = await dripSessionGas('0xkey');
    expect(r).toEqual({ ok: false, suiAmount: '0', code: 'treasury_empty' });
  });

  it('returns ok:false on a network throw rather than propagating it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );
    const r = await dripSessionGas('0xkey');
    expect(r).toEqual({ ok: false, suiAmount: '0', code: 'network' });
  });
});

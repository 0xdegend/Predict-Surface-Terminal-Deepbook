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

  it('dedupes concurrent drips for the SAME key onto one request (no duplicate 409)', async () => {
    // Gate the fetch on a promise we resolve manually, so both calls overlap in-flight.
    let release: (v: unknown) => void = () => {};
    const gate = new Promise((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return { ok: true, status: 200, json: async () => ({ digest: 'd1', suiAmount: '100000000' }) };
    });
    vi.stubGlobal('fetch', fetchMock);

    const a = dripSessionGas('0xsame');
    const b = dripSessionGas('0xsame');
    expect(a).toBe(b); // same in-flight promise, not a second call
    release(undefined);
    const [ra, rb] = await Promise.all([a, b]);

    expect(fetchMock).toHaveBeenCalledTimes(1); // only one POST hit the route
    expect(ra).toEqual(rb);
    expect(ra.ok).toBe(true);
    expect(ra.digest).toBe('d1');
  });

  it('lets a later drip for the same key go through once the first settled', async () => {
    mockFetch(200, { digest: 'first', suiAmount: '100000000' });
    await dripSessionGas('0xkey2');
    mockFetch(200, { digest: 'second', suiAmount: '100000000' });
    const r = await dripSessionGas('0xkey2'); // map cleared on settle → fresh request
    expect(r.digest).toBe('second');
  });
});

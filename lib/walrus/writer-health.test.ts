/**
 * writer-health.test.ts — the writer can only record a call if it can pay for BOTH halves.
 *
 * A Walrus write spends gas (SUI) to land the transaction and storage (WAL) to keep the
 * blob. Until 2026-09-21 this check read only the gas balance, so a wallet holding 1.06 SUI
 * and 0.00088 WAL reported "ok, 152 writes left" while every single POST /api/kelly/receipts
 * came back 502. These cases pin the shape of that mistake: the answer follows whichever
 * resource runs out first, and it names which one so an operator knows what to send.
 *
 * Offline. The balance read is a single GraphQL request, stubbed here.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { writerHealth } from './client';

const WRITER = '0xe6f6f81e28ecc794f4658a67a2075f2856a49bf8850e7571182052fe7c6016ba';
const SUI = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI';
const WAL = '0x8270feb7375eee355e64fdb69c50abb6b5f9393a722883c1cf45f8e26048810a::wal::WAL';

/** Stub the balance API with an exact coin table. */
function balances(rows: { coinType: string; totalBalance: string }[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        data: { address: { balances: { nodes: rows.map((r) => ({ coinType: { repr: r.coinType }, totalBalance: r.totalBalance })) } } },
      }),
    })),
  );
}

/** One write costs 7_000_000 MIST of gas and 1_500_000 FROST of storage. */
const gasFor = (writes: number) => String(7_000_000 * writes);
const walFor = (writes: number) => String(1_500_000 * writes);

beforeEach(() => {
  process.env.WALRUS_WRITER_KEY = 'set-for-the-test';
  process.env.WALRUS_WRITER_ADDRESS = WRITER;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.WALRUS_WRITER_KEY;
  delete process.env.WALRUS_WRITER_ADDRESS;
});

describe('writerHealth', () => {
  it('is healthy when both balances are deep', async () => {
    balances([
      { coinType: SUI, totalBalance: gasFor(500) },
      { coinType: WAL, totalBalance: walFor(500) },
    ]);
    const h = await writerHealth();
    expect(h.ok).toBe(true);
    expect(h.low).toBe(false);
    expect(h.reason).toBe('ok');
    expect(h.writesLeft).toBe(500);
  });

  it('reports the SMALLER of the two, not the gas figure', async () => {
    balances([
      { coinType: SUI, totalBalance: gasFor(500) },
      { coinType: WAL, totalBalance: walFor(42) },
    ]);
    const h = await writerHealth();
    expect(h.writesLeft).toBe(42);
  });

  // The exact 2026-09-21 outage, to the balance. Gas for 152 writes, storage for none.
  it('calls a gas-rich, WAL-dry wallet broken, and says it is the WAL', async () => {
    balances([
      { coinType: SUI, totalBalance: '1065453449' },
      { coinType: WAL, totalBalance: '879287' },
    ]);
    const h = await writerHealth();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe('no_wal');
    expect(h.writesLeft).toBe(0);
    expect(h.suiMist).toBe(1_065_453_449n);
    expect(h.walFrost).toBe(879_287n);
  });

  it('still catches the original failure: WAL-rich, out of gas', async () => {
    balances([
      { coinType: SUI, totalBalance: '0' },
      { coinType: WAL, totalBalance: walFor(500) },
    ]);
    const h = await writerHealth();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe('no_gas');
  });

  it('warns low on whichever side is nearly dry', async () => {
    balances([
      { coinType: SUI, totalBalance: gasFor(900) },
      { coinType: WAL, totalBalance: walFor(5) },
    ]);
    const h = await writerHealth();
    expect(h.ok).toBe(true);
    expect(h.low).toBe(true);
    expect(h.reason).toBe('low_wal');
    expect(h.writesLeft).toBe(5);
  });

  // A wallet that never held WAL has no row at all, which is an answer, not a failed read.
  it('treats a missing coin row as a zero balance', async () => {
    balances([{ coinType: SUI, totalBalance: gasFor(500) }]);
    const h = await writerHealth();
    expect(h.ok).toBe(false);
    expect(h.reason).toBe('no_wal');
    expect(h.walFrost).toBe(0n);
  });

  it('is unconfigured, not broken, with no writer key', async () => {
    delete process.env.WALRUS_WRITER_KEY;
    const h = await writerHealth();
    expect(h.reason).toBe('unconfigured');
    expect(h.ok).toBe(false);
  });

  // Failing to LOOK must not be reported as a broken writer: that is the same mistake as
  // the silence this check replaced, pointed the other way.
  it('stays ok when the balance API cannot be reached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const h = await writerHealth();
    expect(h.reason).toBe('unreadable');
    expect(h.ok).toBe(true);
    expect(h.writesLeft).toBeNull();
  });
});

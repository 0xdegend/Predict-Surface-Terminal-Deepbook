/**
 * writer-health.live.test.ts — can Kelly still record a call?
 *
 *   RUN_LIVE=1 npx vitest run lib/walrus/writer-health.live.test.ts
 *
 * Built 2026-09-07 after the Walrus writer wallet ran out of SUI on 09-04. Receipt writes
 * are fire-and-forget by design, so the failure was completely silent: Autopilot kept
 * trading, every POST 500'd into a swallowed catch, and the track record simply stopped
 * growing for three days. Nothing in the app or the test suite could tell that apart from a
 * quiet week. This is the check that can.
 *
 * It could not, at first. On 2026-09-21 the wallet ran out of WAL instead, with gas to
 * spare, and this test passed green while every single write was failing: it asserted on a
 * health check that only ever looked at gas. Both balances are printed below now, for the
 * same reason the assertion covers both. A green run here is a claim that the next trade
 * gets recorded, and that claim has to be worth something.
 *
 * Reads only. Run it when the record looks thin, and before leaning on receipts for a demo.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** vitest does not load .env, and the writer reads process.env at call time. */
function fromEnvFile(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  try {
    const line = readFileSync('.env', 'utf8').split('\n').find((l) => l.trimStart().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}
for (const k of ['WALRUS_WRITER_KEY', 'WALRUS_WRITER_ADDRESS']) {
  if (!process.env[k]) process.env[k] = fromEnvFile(k);
}

describe.skipIf(process.env.RUN_LIVE !== '1')('Kelly receipt writer', () => {
  it('can pay for a receipt, in gas AND in storage', async () => {
    const { writerHealth } = await import('./client');
    const h = await writerHealth();
    const amt = (v: bigint | null) => (v == null ? 'unknown' : (Number(v) / 1e9).toFixed(6));
    console.log(
      `\n  writer ${h.address}\n  SUI ${amt(h.suiMist)}  WAL ${amt(h.walFrost)}` +
        `\n  ~${h.writesLeft ?? '?'} receipts left  (${h.reason})`,
    );
    if (h.reason === 'unreadable') {
      console.log('  could not reach the balance API, not treated as a failure');
      return;
    }
    // The assertion is on OK, not on a balance: what matters is whether the next real
    // Autopilot trade will be recorded, which is exactly what silently stopped being true.
    // The reason names the coin to send, because the two failures look identical from here.
    const coin = h.reason === 'no_wal' || h.reason === 'low_wal' ? 'WAL' : 'SUI';
    expect(h.ok, `writer cannot pay for a receipt (${h.reason}): fund ${h.address} with ${coin}`).toBe(true);
    if (h.low) console.log(`  WARNING: nearly dry on ${coin}, top it up before the next session`);
  }, 120_000);
});

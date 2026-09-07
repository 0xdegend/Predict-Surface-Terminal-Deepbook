import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
function env(k: string): string {
  if (process.env[k]) return process.env[k] as string;
  try {
    const l = readFileSync('.env', 'utf8').split('\n').find((x) => x.trimStart().startsWith(`${k}=`));
    return l ? l.slice(l.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch { return ''; }
}
for (const k of ['WALRUS_WRITER_KEY', 'WALRUS_WRITER_ADDRESS']) if (!process.env[k]) process.env[k] = env(k);

describe.skipIf(process.env.RUN_LIVE !== '1')('walrus write', () => {
  it('actually stores and reads back a blob', async () => {
    const { storeJson, readBlobJson } = await import('./client');
    const payload = { probe: 'receipts-restored', at: Date.now() };
    const out = await storeJson(payload);
    console.log(`\n  WROTE blobId=${out.blobId}  endEpoch=${out.endEpoch}`);
    const back = await readBlobJson<typeof payload>(out.blobId);
    console.log(`  READ BACK ${JSON.stringify(back)}`);
    expect(back.at).toBe(payload.at);
  }, 300_000);
});

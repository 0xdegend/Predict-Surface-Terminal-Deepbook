/**
 * cutover-preflight.live.test.ts — the gate that must be green before 8-21 goes live.
 *
 * The migration's one irreversible step is the leaderboard. Everything else rolls back with
 * an env var: point `NEXT_PUBLIC_PREDICT_DEPLOYMENT` back at 8-06 and the app is exactly
 * what it was. But trades that happen on 8-06 AFTER the final snapshot are captured nowhere.
 * They are not lost on chain, they are simply not in the file we carry forward, and nobody
 * notices, because a leaderboard that is short a few hundred trades still looks like a
 * leaderboard.
 *
 * So the freshness of that snapshot is asserted here rather than written on a checklist.
 * Measured 2026-08-31: Skew trades land at roughly 3 per hour, so a snapshot taken the day
 * before cutover silently drops something like seventy trades.
 *
 * Run this LAST, immediately before flipping the env var:
 *
 *   NEXT_PUBLIC_PREDICT_DEPLOYMENT=8-21 RUN_LIVE=1 \
 *     npx vitest run lib/leaderboard/cutover-preflight.live.test.ts
 *
 * A failure here is not a bug to work around. It is the preflight doing its job: re-run the
 * capture (see the runbook, MIGRATION-8-21.md) and run this again.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, ACTIVE_V2_DEPLOYMENT, V2_IS_821_PLUS } from '@/config/predict';
import { LEGACY_SEEDS, LEGACY_OWNERS, LEGACY_TOTAL_POINTS } from './legacy-carryover';
import { legacyHistoryByOwner } from '@/lib/portfolio/legacy-history-data';
import pointsSeed806 from './legacy-points-8-06.json';

const RUN = process.env.RUN_LIVE === '1';

/**
 * How stale the outgoing deployment's snapshot may be at cutover.
 *
 * Six hours, so the capture has to happen in the same working session as the deploy rather
 * than "yesterday, probably". Override with SEED_MAX_AGE_HOURS for a rehearsal, never for
 * the real thing.
 */
const MAX_SEED_AGE_HOURS = Number(process.env.SEED_MAX_AGE_HOURS ?? 6);

/** The deployment we are migrating AWAY from, whose final board must be captured. */
const OUTGOING = '8-06';

/**
 * Read a variable from `.env` directly.
 *
 * Vitest does not load `.env` the way Next does, and `config/predict.ts` resolves its env at
 * MODULE LOAD, so a value set later in a test body arrives too late to matter. Between those
 * two facts, a preflight that trusted `process.env` reported "not set" for a variable that
 * was sitting correctly in `.env`, which is worse than no gate: it fails the one case it was
 * built to approve, and the obvious way to "fix" it is to stop believing it.
 *
 * Reading the file is also the more honest check. What ships is what is in `.env`, not what
 * happens to be exported in the shell that ran the tests. A real environment variable still
 * wins, so a one-off command-line override behaves as expected.
 */
function fromEnvFile(key: string): string {
  if (process.env[key]) return process.env[key] as string;
  try {
    const line = readFileSync('.env', 'utf8')
      .split('\n')
      .find((l) => l.trimStart().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return ''; // no .env at all (CI) — treated as unset, which is the correct answer there
  }
}

describe.skipIf(!RUN)('8-21 cutover preflight', () => {
  it(`has a snapshot of ${OUTGOING} taken within the last ${MAX_SEED_AGE_HOURS}h`, () => {
    const seed = pointsSeed806 as unknown as { capturedAt: string; rows: unknown[] };
    const ageHours = (Date.now() - new Date(seed.capturedAt).getTime()) / 3_600_000;
    const trades = Math.round(ageHours * 3); // measured rate, for a concrete failure message

    console.log(`${OUTGOING} snapshot: ${seed.capturedAt} (${ageHours.toFixed(1)}h old, ${seed.rows.length} traders)`);
    expect(
      ageHours,
      `The ${OUTGOING} snapshot is ${ageHours.toFixed(1)}h old, so roughly ${trades} trades made since ` +
        `then would not carry over. Re-run the capture before cutting over:\n\n` +
        `  env RUN_LIVE=1 CAPTURE_SEED=1 "$(grep '^NEXT_PUBLIC_BUILDER_CODE_ID=' .env)" \\\n` +
        `    npx vitest run lib/leaderboard/capture-seed.live.test.ts\n`,
    ).toBeLessThan(MAX_SEED_AGE_HOURS);
  });

  it('carries both retired boards, and never the one it is about to read live', () => {
    // The double-count guard, checked against the REAL registry at the moment of cutover
    // rather than against a fixture.
    const carried = LEGACY_SEEDS.map((s) => s.deployment);
    console.log(`carrying: ${carried.join(' + ')} → ${LEGACY_OWNERS.length} traders, ${Math.round(LEGACY_TOTAL_POINTS)} points`);
    expect(carried).toContain('6-24');
    expect(carried).toContain(OUTGOING);
    expect(carried, 'a snapshot of the live deployment is being overlaid — the board would double').not.toContain(
      ACTIVE_V2_DEPLOYMENT,
    );
  });

  it('carries a history row for every trader it carries points for', () => {
    // The two snapshots are captured together and must stay in step. A points board with no
    // matching history gives a returning trader a rank and an empty history tab.
    const history = legacyHistoryByOwner();
    const withHistory = LEGACY_OWNERS.filter((o) => (history[o]?.length ?? 0) > 0);
    const rows = Object.values(history).flat().length;
    console.log(`history: ${Object.keys(history).length} wallets, ${rows} rows`);
    expect(rows).toBeGreaterThan(0);
    // Not every trader has a SETTLED trade (a wallet whose only bets are still open has
    // points but no history yet), so this is a floor rather than an equality.
    expect(withHistory.length, 'almost nobody has carried history — the two seeds are out of step').toBeGreaterThan(
      LEGACY_OWNERS.length * 0.5,
    );
  });

  it('is pointed at 8-21, with a builder code registered on it', async () => {
    // Phase 6. Without this the fee rail earns nothing and, worse, the new board cannot tell
    // a Skew trade from anyone else's, so the Skew leaderboard starts empty and stays empty.
    expect(ACTIVE_V2_DEPLOYMENT).toBe('8-21');
    expect(V2_IS_821_PLUS).toBe(true);

    const codeId = fromEnvFile('NEXT_PUBLIC_BUILDER_CODE_ID_821');
    expect(
      codeId,
      'NEXT_PUBLIC_BUILDER_CODE_ID_821 is not set in .env — register the builder code on 8-21 first (Phase 6)',
    ).toMatch(/^0x[0-9a-f]{64}$/);

    const client = new SuiGrpcClient({ network: 'testnet', baseUrl: predictV2Config.grpcUrl });
    const res = await client.core.getObjects({ objectIds: [codeId], include: { json: true } });
    const obj = res.objects[0];
    const bad = obj instanceof Error || !obj;
    const type = bad ? '' : String((obj as { type?: string }).type ?? '');
    const json = bad ? {} : ((obj as { json?: Record<string, unknown> }).json ?? {});
    console.log(`builder code ${codeId.slice(0, 12)}… → ${type || 'NOT FOUND'}`);
    console.log(`  owner ${String(json.owner ?? '?').slice(0, 12)}…  index ${String(json.index ?? '?')}`);

    expect(type, 'the configured builder code does not exist on 8-21').toContain('builder_code::BuilderCode');
    // The decisive check. A code from a previous deployment is a real, resolvable, correctly
    // typed object — it simply belongs to a registry 8-21 has never heard of, so trades would
    // attribute to nothing and the fee rail would earn nothing, silently.
    expect(type, 'this builder code belongs to a DIFFERENT predict package than 8-21').toContain(
      predictV2Config.packages.predict,
    );
  }, 60_000);

  it('resolves every 8-21 shared object it is about to trade against', async () => {
    const client = new SuiGrpcClient({ network: 'testnet', baseUrl: predictV2Config.grpcUrl });
    const ids = Object.entries(predictV2Config.shared).filter(([, v]) => !!v) as [string, string][];
    const res = await client.core.getObjects({ objectIds: ids.map(([, v]) => v), include: { json: true } });
    const missing: string[] = [];
    ids.forEach(([name], i) => {
      const o = res.objects[i];
      if (o instanceof Error || !o) missing.push(name);
    });
    console.log(`shared objects resolved: ${ids.length - missing.length}/${ids.length}`);
    expect(missing, `unresolvable shared objects: ${missing.join(', ')}`).toEqual([]);
  }, 60_000);
});

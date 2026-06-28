/**
 * snapshot-legacy.mjs — archive the LEGACY Predict deployment to a JSON file
 * before DeepBook's old server / oracles wind down.
 *
 * This is our "Season 1" capture: the global trade/range event streams, every
 * manager + their summaries & positions, the oracle list, and the vault summary.
 * From it we can later rebuild the legacy leaderboard standings and let users
 * review their old trading history even after the old server goes offline.
 *
 * Plain ESM, zero dependencies (Node 18+ global fetch). Run from the app root:
 *
 *   node scripts/snapshot-legacy.mjs
 *   node scripts/snapshot-legacy.mjs --limit 50000 --concurrency 8 --out data/legacy-season1.json
 *
 * It tolerates per-endpoint failures (records the error, keeps going) so even a
 * partially-reachable server still produces a useful archive.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// --- Frozen legacy values (mirror config/predict.ts TESTNET; safe to inline in
//     a one-off archival script — the legacy deployment never changes). --------
const LEGACY_SERVER = 'https://predict-server.testnet.mystenlabs.com';
const PREDICT_OBJECT = '0xc8736204d12f0a7277c86388a68bf8a194b0a14c5538ad13f22cbd8e2a38028a';

// --- CLI flags ---------------------------------------------------------------
function flag(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const EVENT_LIMIT = Number(flag('limit', '50000'));
const CONCURRENCY = Number(flag('concurrency', '8'));
const MANAGER_CAP = Number(flag('managers', '100000')); // cap per-manager enrichment
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '..', flag('out', 'data/legacy-season1.json'));

// --- fetch helper with timeout + retry --------------------------------------
async function getJson(path, { tries = 3, timeoutMs = 30000 } = {}) {
  const url = `${LEGACY_SERVER}${path}`;
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      if (attempt < tries) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw lastErr;
}

/** Run async tasks with a bounded worker pool, preserving input order. */
async function pool(items, worker, size) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) break;
        out[i] = await worker(items[i], i);
      }
    }),
  );
  return out;
}

const errors = [];
async function capture(label, fn) {
  process.stdout.write(`  • ${label} … `);
  try {
    const data = await fn();
    const n = Array.isArray(data) ? data.length : data ? 1 : 0;
    console.log(`ok${Array.isArray(data) ? ` (${n})` : ''}`);
    return data;
  } catch (e) {
    console.log(`FAILED (${e.message})`);
    errors.push({ label, message: e.message });
    return null;
  }
}

async function main() {
  console.log(`\nArchiving legacy Predict → ${OUT}\n`);
  const P = encodeURIComponent(PREDICT_OBJECT);

  const status = await capture('status', () => getJson('/status'));
  const state = await capture('predict state', () => getJson(`/predicts/${P}/state`));
  const oracles = await capture('oracles', () => getJson(`/predicts/${P}/oracles`));
  const vaultSummary = await capture('vault summary', () => getJson(`/predicts/${P}/vault/summary`));

  const positionsMinted = await capture('positions minted', () =>
    getJson(`/positions/minted?limit=${EVENT_LIMIT}`));
  const positionsRedeemed = await capture('positions redeemed', () =>
    getJson(`/positions/redeemed?limit=${EVENT_LIMIT}`));
  const rangesMinted = await capture('ranges minted', () =>
    getJson(`/ranges/minted?limit=${EVENT_LIMIT}`));
  const rangesRedeemed = await capture('ranges redeemed', () =>
    getJson(`/ranges/redeemed?limit=${EVENT_LIMIT}`));

  const managers = (await capture('managers', () => getJson(`/managers?limit=${EVENT_LIMIT}`))) ?? [];

  // Per-manager enrichment (summary + positions) — what the leaderboard needs
  // for PnL and win-rate. Bounded concurrency so we don't hammer the server.
  const ids = managers
    .map((m) => m.manager_id ?? m.id)
    .filter(Boolean)
    .slice(0, MANAGER_CAP);
  console.log(`  • enriching ${ids.length} managers (concurrency ${CONCURRENCY}) …`);
  let done = 0;
  const enrichment = await pool(
    ids,
    async (id) => {
      const eid = encodeURIComponent(id);
      const [summary, positions] = await Promise.all([
        getJson(`/managers/${eid}/summary`).catch((e) => ({ error: e.message })),
        getJson(`/managers/${eid}/positions/summary`).catch((e) => ({ error: e.message })),
      ]);
      if (++done % 25 === 0 || done === ids.length) process.stdout.write(`    ${done}/${ids.length}\r`);
      return { manager_id: id, summary, positions };
    },
    CONCURRENCY,
  );
  console.log('');

  const archive = {
    meta: {
      season: 1,
      label: 'Legacy Predict (predict-testnet-4-16 era)',
      server: LEGACY_SERVER,
      predictObject: PREDICT_OBJECT,
      capturedAt: new Date().toISOString(),
      eventLimit: EVENT_LIMIT,
      counts: {
        managers: managers.length,
        enriched: enrichment.length,
        positionsMinted: positionsMinted?.length ?? 0,
        positionsRedeemed: positionsRedeemed?.length ?? 0,
        rangesMinted: rangesMinted?.length ?? 0,
        rangesRedeemed: rangesRedeemed?.length ?? 0,
      },
      errors,
    },
    status,
    state,
    oracles,
    vaultSummary,
    managers,
    enrichment,
    positionsMinted,
    positionsRedeemed,
    rangesMinted,
    rangesRedeemed,
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(archive, null, 2));
  const { counts } = archive.meta;
  console.log(`\nDone. ${counts.managers} managers, ${counts.positionsMinted} mints, ` +
    `${counts.positionsRedeemed} redeems archived.`);
  if (errors.length) console.log(`(${errors.length} endpoint(s) failed — see meta.errors in the file.)`);
  console.log(`Wrote ${OUT}\n`);
}

main().catch((e) => {
  console.error('\nFatal:', e);
  process.exit(1);
});

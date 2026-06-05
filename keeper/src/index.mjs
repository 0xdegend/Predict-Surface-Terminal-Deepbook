/**
 * keeper/src/index.mjs — entry point. Wires env → config, client, signer, opts
 * and starts the poll loop.
 *
 * Run:  node --env-file=.env src/index.mjs      (see .env.example / README)
 *
 * Env:
 *   SUI_NETWORK            testnet | mainnet           (default testnet)
 *   KEEPER_SECRET_KEY      bech32 `suiprivkey1...`     (from `sui keytool export`)
 *   KEEPER_MNEMONIC        12/24-word phrase           (alternative to SECRET_KEY)
 *   DRY_RUN               "true" → discover + simulate, never submit
 *   POLL_INTERVAL_MS       default 20000
 *   MAX_REDEEMS_PER_TICK   default 10
 *   MANAGER_SCAN_LIMIT     default 150
 *   MINTED_LIMIT           default 3000
 *   CONCURRENCY            default 8
 *   COOLDOWN_MS            default 300000 (5 min)
 */
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';
import { SuiJsonRpcClient } from '@mysten/sui/jsonRpc';
import { loadConfig } from './config.mjs';
import { makeServer } from './server.mjs';
import { runLoop } from './keeper.mjs';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

function loadSigner() {
  const sk = process.env.KEEPER_SECRET_KEY?.trim();
  const mn = process.env.KEEPER_MNEMONIC?.trim();
  if (sk) return Ed25519Keypair.fromSecretKey(sk);
  if (mn) return Ed25519Keypair.deriveKeypair(mn);
  return null;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

async function main() {
  const cfg = loadConfig();
  const dryRun = process.env.DRY_RUN === 'true';

  const signer = loadSigner();
  if (!signer && !dryRun) {
    throw new Error(
      'No KEEPER_SECRET_KEY / KEEPER_MNEMONIC set. Set one, or run with DRY_RUN=true to scan only.',
    );
  }

  const client = new SuiJsonRpcClient({ url: cfg.jsonRpcUrl, network: cfg.network });
  const server = makeServer(cfg);

  const opts = {
    dryRun,
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 20_000),
    maxRedeemsPerTick: num(process.env.MAX_REDEEMS_PER_TICK, 10),
    managerScanLimit: num(process.env.MANAGER_SCAN_LIMIT, 150),
    mintedLimit: num(process.env.MINTED_LIMIT, 3000),
    concurrency: num(process.env.CONCURRENCY, 8),
    cooldownMs: num(process.env.COOLDOWN_MS, 300_000),
  };

  const who = signer ? signer.toSuiAddress() : '(no signer — scan only)';
  log(`Predict settled-redeem keeper · ${cfg.network} · keeper=${who}`);
  log(`mode=${dryRun ? 'DRY-RUN' : 'LIVE'} poll=${opts.pollIntervalMs}ms maxPerTick=${opts.maxRedeemsPerTick}`);

  const seen = new Map();
  await runLoop({ server, client, signer, cfg, opts, seen, log });
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});

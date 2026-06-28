/**
 * keeper/v2/index.mjs — entry point for the v2 keeper (settled-redeem + liquidation).
 *
 * Run:  node --env-file=.env keeper/v2/index.mjs       (DRY_RUN=true to scan only)
 *
 * Env:
 *   SUI_NETWORK              testnet | mainnet            (default testnet)
 *   KEEPER_SECRET_KEY        bech32 suiprivkey1...        (or KEEPER_MNEMONIC)
 *   DRY_RUN                  "true" → discover + simulate, never submit
 *   POLL_INTERVAL_MS         default 20000
 *   MAX_PER_TICK             default 10
 *   MARKET_LIMIT             default 100
 *   STATE_SCAN_LIMIT         default 60
 *   LIQUIDATION_MARKET_LIMIT default 12
 *   CONCURRENCY              default 8
 *   COOLDOWN_MS              default 300000
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

const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function main() {
  const cfg = loadConfig();
  const dryRun = process.env.DRY_RUN === 'true';
  const signer = loadSigner();
  if (!signer && !dryRun) {
    throw new Error('No KEEPER_SECRET_KEY / KEEPER_MNEMONIC set. Set one, or run DRY_RUN=true to scan only.');
  }
  const client = new SuiJsonRpcClient({ url: cfg.jsonRpcUrl, network: cfg.network });
  const server = makeServer(cfg);
  const opts = {
    dryRun,
    pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 20_000),
    maxPerTick: num(process.env.MAX_PER_TICK, 10),
    marketLimit: num(process.env.MARKET_LIMIT, 100),
    stateScanLimit: num(process.env.STATE_SCAN_LIMIT, 60),
    liquidationMarketLimit: num(process.env.LIQUIDATION_MARKET_LIMIT, 12),
    concurrency: num(process.env.CONCURRENCY, 8),
    cooldownMs: num(process.env.COOLDOWN_MS, 300_000),
  };
  const who = signer ? signer.toSuiAddress() : '(no signer — scan only)';
  log(`Predict v2 keeper · ${cfg.network} · keeper=${who} · mode=${dryRun ? 'DRY-RUN' : 'LIVE'}`);
  await runLoop({ server, client, signer, cfg, opts, seen: new Map(), log });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

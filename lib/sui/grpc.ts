/**
 * lib/sui/grpc.ts — health-aware gRPC endpoint selection with automatic failover.
 *
 * WHY THIS EXISTS: the app reads all live on-chain state (the surface pricer, quotes)
 * and submits trades over gRPC against a Sui fullnode. On 2026-07-31 Mysten's public
 * testnet fullnode STALLED ~37k versions behind: it kept serving old objects but
 * returned NOT_FOUND for every freshly-created market, so the surface went blank,
 * markets read "-", and trading died, while the HTTP indexer feeds stayed green.
 *
 * WHAT THIS DOES: it keeps an ordered list of candidate endpoints (Mysten first, a
 * synced third-party second) and a background monitor that every ~40s measures how
 * fresh each node is and picks the best one. It PREFERS the primary (Mysten) whenever
 * it is caught up, so once Mysten recovers the app returns to it on its own with no
 * manual step. The choice is persisted, so a reload starts on the last-known-good
 * endpoint instead of relearning from scratch.
 *
 * Failover is automatic in BOTH directions:
 *   - reads (surface/quotes): the health-aware read client recreates on a switch, so
 *     the surface heals within one poll, no reload;
 *   - the wallet/tx client (built once by dapp-kit): uses the persisted choice, so it
 *     lands on the healthy node at load and returns to Mysten on the next load once it
 *     is healthy again.
 */
import { useSyncExternalStore } from 'react';
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, type SuiNetwork, getPredictV2Config } from '@/config/predict';

/** The preferred endpoint (Mysten). Override with NEXT_PUBLIC_SUI_GRPC_URL. */
const PRIMARY_URL = process.env.NEXT_PUBLIC_SUI_GRPC_URL || predictV2Config.grpcUrl;
/** The failover endpoint — a synced node that speaks the same gRPC v2 API + CORS.
 *  Verified 2026-07-31: rpc-testnet.suiscan.xyz serves gRPC, is fully synced, and
 *  sends open CORS. Override with NEXT_PUBLIC_SUI_GRPC_FALLBACK. */
const FALLBACK_URL = process.env.NEXT_PUBLIC_SUI_GRPC_FALLBACK || 'https://rpc-testnet.suiscan.xyz';

/** Ordered by preference (earlier = preferred when healthy). Deduped. */
const CANDIDATES: string[] = [...new Set([PRIMARY_URL, FALLBACK_URL])];

/** A hot shared object we use as the freshness yardstick: the pool vault mutates on
 *  every market create/settle (~every minute), so a stalled node reports a much lower
 *  version than a synced one. */
const FRESHNESS_OBJECT = predictV2Config.shared.poolVault;
/** How far a node may lag the freshest candidate and still be considered healthy. A
 *  synced node lags by a handful of versions; the 2026-07-31 stall was ~37,000. */
const LAG_TOLERANCE = 2_000;
const PROBE_INTERVAL_MS = 40_000;
const LS_KEY = 'skew.grpc.endpoint';

const isBrowser = typeof window !== 'undefined';

function readPersisted(): string | null {
  if (!isBrowser) return null;
  try {
    const v = window.localStorage.getItem(LS_KEY);
    return v && CANDIDATES.includes(v) ? v : null;
  } catch {
    return null;
  }
}

// Current choice. Seed from the last-known-good endpoint so a reload during an outage
// starts healthy instead of retrying the stalled node.
let active: string = readPersisted() ?? PRIMARY_URL;

/** The endpoint every gRPC client should currently use. */
export function activeGrpcUrl(): string {
  return active;
}

/** Sync resolver for client factories (e.g. dapp-kit's createClient). Only testnet
 *  has a failover peer wired; other networks use their configured endpoint. */
export function resolveGrpcUrl(network: SuiNetwork): string {
  return network === 'testnet' ? active : getPredictV2Config(network).grpcUrl;
}

/* ----------------------------- change subscription ----------------------------- */

const listeners = new Set<() => void>();
function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
function setActive(url: string): void {
  if (url === active || !CANDIDATES.includes(url)) return;
  active = url;
  if (isBrowser) {
    try {
      window.localStorage.setItem(LS_KEY, url);
    } catch {
      /* private mode / disabled storage — the in-memory choice still holds. */
    }
  }
  _read = null; // force the read client to rebuild on the new endpoint
  for (const cb of listeners) cb();
}

/* ------------------------------- read client ---------------------------------- */

let _read: SuiGrpcClient | null = null;
let _readUrl = '';
/** Health-aware read client for surface/quote simulates. Recreated on a failover so
 *  callers that fetch it fresh (the pricer hooks) transparently follow the switch. */
export function v2ReadClient(): SuiGrpcClient {
  if (!_read || _readUrl !== active) {
    _readUrl = active;
    _read = new SuiGrpcClient({ network: 'testnet', baseUrl: active });
  }
  return _read;
}

/** React hook: the current read client, re-rendering the caller when the endpoint
 *  fails over so the live query picks up the healthy node on its next poll. */
export function useV2ReadClient(): SuiGrpcClient {
  useSyncExternalStore(
    subscribe,
    () => active,
    () => active,
  );
  return v2ReadClient();
}

/* ------------------------------ health monitor -------------------------------- */

/** Latest version a node reports for the freshness object, or -1 if unreachable. */
async function probe(url: string): Promise<number> {
  try {
    const c = new SuiGrpcClient({ network: 'testnet', baseUrl: url });
    const r = (await c.core.getObject({ objectId: FRESHNESS_OBJECT })) as {
      object?: { version?: string | number };
      version?: string | number;
    };
    const v = Number(r?.object?.version ?? r?.version ?? -1);
    return Number.isFinite(v) ? v : -1;
  } catch {
    return -1;
  }
}

async function evaluate(): Promise<void> {
  if (CANDIDATES.length < 2) return; // nothing to fail over to
  const versions = await Promise.all(CANDIDATES.map(probe));
  const best = Math.max(...versions);
  if (best < 0) return; // every candidate unreachable — keep the current choice
  // Pick the FIRST (most-preferred) candidate that is caught up. This returns to
  // the primary automatically the moment it is within tolerance again.
  const idx = CANDIDATES.findIndex((_, i) => versions[i] >= 0 && best - versions[i] <= LAG_TOLERANCE);
  if (idx >= 0) setActive(CANDIDATES[idx]);
}

let started = false;
/** Start the background endpoint health monitor (client-side, once). Safe to call
 *  from a React effect on every mount — it self-guards against duplicate timers. */
export function startGrpcHealthMonitor(): void {
  if (started || !isBrowser || CANDIDATES.length < 2) return;
  started = true;
  void evaluate(); // decide immediately on load, then keep it current
  window.setInterval(() => void evaluate(), PROBE_INTERVAL_MS);
}

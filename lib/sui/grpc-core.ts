/**
 * lib/sui/grpc-core.ts — health-aware gRPC endpoint selection with automatic failover.
 *
 * FRAMEWORK-FREE ON PURPOSE. The React hook lives in the `grpc.ts` barrel beside this
 * file, because a module that so much as IMPORTS `useSyncExternalStore` cannot be pulled
 * into a React Server Component — and the server is exactly where this is needed: the
 * route that broke on 2026-08-21 (`/api/v2/pyth`) runs server-side, as do the RSC page
 * seeds. Keeping the endpoint logic here lets both sides share ONE choice of endpoint.
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
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { predictV2Config, type SuiNetwork, getPredictV2Config } from '@/config/predict';

/** The historical failover peer. Kept in the list because it costs nothing while the
 *  primary is healthy and it may come back; it was timing out as of 2026-08-21. */
const DEFAULT_FALLBACK = 'https://rpc-testnet.suiscan.xyz';

/** Split a comma-separated endpoint list, so either env var can carry several. */
const urlList = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

const ENV_PRIMARY = urlList(process.env.NEXT_PUBLIC_SUI_GRPC_URL);
const ENV_FALLBACK = urlList(process.env.NEXT_PUBLIC_SUI_GRPC_FALLBACK);

/** The preferred endpoint (Mysten). Override with NEXT_PUBLIC_SUI_GRPC_URL. */
const PRIMARY_URL = ENV_PRIMARY[0] || predictV2Config.grpcUrl;

/**
 * Ordered by preference (earlier = preferred when healthy). Deduped.
 *
 * BOTH env vars accept a COMMA-SEPARATED LIST, so a new endpoint can be added in an
 * incident without a deploy. That matters more than it sounds: a census on 2026-08-21
 * found that of eleven public testnet endpoints, exactly ONE still spoke gRPC v2
 * (`fullnode.testnet.sui.io`). suiscan — the peer this list was built around on
 * 2026-07-31 — was returning Gateway Timeout, and blastapi/rpcpool answered `Forbidden`,
 * meaning they work with an API key. So the honest state of failover is: the mechanism
 * below is real, and the bench is one deep until a keyed endpoint is added here.
 * See [[testnet-grpc-fullnode-stall]].
 */
const CANDIDATES: string[] = [...new Set([PRIMARY_URL, ...ENV_PRIMARY.slice(1), ...ENV_FALLBACK, DEFAULT_FALLBACK])];

/** A hot shared object we use as the freshness yardstick: the pool vault mutates on
 *  every market create/settle (~every minute), so a stalled node reports a much lower
 *  version than a synced one. */
const FRESHNESS_OBJECT = predictV2Config.shared.poolVault;
/** How far a node may lag the freshest candidate and still be considered healthy. A
 *  synced node lags by a handful of versions; the 2026-07-31 stall was ~37,000. */
const LAG_TOLERANCE = 2_000;
const PROBE_INTERVAL_MS = 40_000;
const LS_KEY = 'skew.grpc.endpoint';

/**
 * Wall-clock budget for a single read, and for a single health probe.
 *
 * A HUNG NODE IS WORSE THAN A DEAD ONE. On 2026-08-21 suiscan answered nothing at all
 * and the underlying client waited SIXTY SECONDS before giving up — long enough that the
 * nav price tape and every strike on the positions rail simply never arrived, with no
 * error for the UI to react to and no chance for the stale-feed overlay to fire. Five
 * seconds is far longer than a healthy read (a live census: 509-621ms) and short enough
 * that a failure turns into a retry on the next endpoint rather than a spinner.
 */
const READ_TIMEOUT_MS = 5_000;
const PROBE_TIMEOUT_MS = 5_000;

/** Reject when `p` outlives `ms`. `signal` lets the caller abort the real work too, so a
 *  timed-out read is cancelled rather than left in flight. */
function withTimeout<T>(p: Promise<T>, ms: number, onTimeout?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.();
        reject(new Error(`gRPC read exceeded ${ms}ms`));
      }, ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

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
export function subscribe(cb: () => void): () => void {
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


/* --------------------------- per-request failover ------------------------------ */

/** One client per endpoint, so a retry does not rebuild a connection each attempt. */
const clients = new Map<string, SuiGrpcClient>();
function clientFor(url: string): SuiGrpcClient {
  let c = clients.get(url);
  if (!c) {
    c = new SuiGrpcClient({ network: 'testnet', baseUrl: url });
    clients.set(url, c);
  }
  return c;
}

/** Combine the caller's cancellation with our timeout, when the runtime supports it. */
function joinSignals(a: AbortSignal, b?: AbortSignal): AbortSignal {
  if (!b) return a;
  const any = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  return any ? any([a, b]) : a;
}

/**
 * Run a read with a time budget, retrying on the next endpoint if this one fails.
 *
 * WHY PER-REQUEST AND NOT JUST THE MONITOR. The background monitor below re-evaluates
 * every 40s, so on its own a node going down means up to 40 seconds of failed reads
 * before the switch — which for a 1s price tape is hundreds of dropped polls. Retrying
 * inside the failing request heals on the very first one instead.
 *
 * The endpoint that answers is PROMOTED, so the cost of a dead node is paid once rather
 * than on every subsequent read. The monitor still owns the walk BACK to the preferred
 * node once it recovers; this only ever reacts to a failure.
 *
 * The callback receives a signal — forward it to the SDK call so a timed-out attempt is
 * actually cancelled instead of left in flight behind the retry.
 */
export async function grpcRead<T>(
  run: (client: SuiGrpcClient, signal: AbortSignal) => Promise<T>,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<T> {
  const budget = opts?.timeoutMs ?? READ_TIMEOUT_MS;
  // The live endpoint first, then the rest in preference order.
  const order = [active, ...CANDIDATES.filter((u) => u !== active)];
  let lastError: unknown;

  for (const url of order) {
    const ctrl = new AbortController();
    try {
      const out = await withTimeout(
        run(clientFor(url), joinSignals(ctrl.signal, opts?.signal)),
        budget,
        () => ctrl.abort(),
      );
      if (url !== active) setActive(url); // this one answered — stop paying for the other
      return out;
    } catch (e) {
      // A caller-initiated cancel is not an endpoint fault: stop, don't burn the list.
      if (opts?.signal?.aborted) throw e;
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error('every gRPC endpoint failed');
}

/* ------------------------------ health monitor -------------------------------- */

/** Latest version a node reports for the freshness object, or -1 if unreachable.
 *  Time-boxed: without a budget a hung candidate held every evaluate() cycle open for a
 *  full minute, so the 40s cycles overlapped and piled up pending requests during exactly
 *  the outage this monitor exists for. */
async function probe(url: string): Promise<number> {
  const ctrl = new AbortController();
  try {
    const r = (await withTimeout(
      clientFor(url).core.getObject({ objectId: FRESHNESS_OBJECT, signal: ctrl.signal }),
      PROBE_TIMEOUT_MS,
      () => ctrl.abort(),
    )) as {
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

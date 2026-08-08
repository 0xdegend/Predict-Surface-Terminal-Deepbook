/**
 * lib/sui/v2/checkpoint-stream.ts — one shared gRPC checkpoint stream that pushes
 * "object X changed" notifications, so live data (spot, chart, odds) can refresh the
 * instant a write lands instead of waiting for the next poll tick.
 *
 * WHY: on 8-06 the BTC pyth feed is written ~4x/second on-chain. Polling it every
 * 1.5s means the chart's live edge and the top tape trail the real price by up to
 * that interval. The Sui gRPC v2 `SubscriptionService.SubscribeCheckpoints` server-
 * streams every checkpoint (~2-3/s on testnet); we filter each one for the objects
 * callers care about and fire a callback the moment ours appears. Verified live
 * 2026-08-08 that BOTH our endpoints (Mysten + suiscan) server-stream from a browser-
 * style gRPC-Web-over-fetch transport with open CORS.
 *
 * WHAT WE STREAM: only the changed-object IDs + versions (a tiny read_mask). We do
 * NOT stream object CONTENTS — a mask that pulls every object's json stalled the
 * stream in testing (1 checkpoint in 45s vs 24 in 8.7s for id-only). Callers take the
 * "it changed" signal and do a single targeted read for the fresh value (reusing the
 * existing decoders), which stays light and works on mainnet-scale traffic too.
 *
 * ROBUSTNESS: one stream for the whole app, reference-counted so it runs only while
 * something is watching; auto-reconnects with backoff on error/close; pauses while
 * the tab is hidden (a background tab needs no live ticks); and reconnects against
 * the CURRENTLY-active gRPC endpoint, so it follows the health-aware failover.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { activeGrpcUrl } from '@/lib/sui/grpc';
import { predictV2Config } from '@/config/predict';

/** What a watcher is told when its object shows up in a checkpoint. */
export interface ObjectChange {
  /** The object's new version after this checkpoint (string; may be undefined). */
  version?: string;
  /** Checkpoint timestamp in ms (from the checkpoint summary), or null if absent. */
  checkpointMs: number | null;
  /** Checkpoint sequence number, for de-dup / ordering. */
  seq: number;
}

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';

type ChangeCb = (change: ObjectChange) => void;

const isBrowser = typeof window !== 'undefined';

/** objectId (lowercased) → set of callbacks. */
const watchers = new Map<string, Set<ChangeCb>>();
/** Only the fields of the stream response we read — kept loose over the deep proto. */
interface CkptMsg {
  cursor?: bigint;
  checkpoint?: {
    sequenceNumber?: bigint;
    summary?: { timestamp?: { seconds?: bigint; nanos?: number } };
    transactions?: {
      effects?: { changedObjects?: { objectId?: string; outputVersion?: bigint }[] };
    }[];
  };
}

let controller: AbortController | null = null;
let running = false;
let backoffMs = 500;
const BACKOFF_MAX = 5_000;
let connectUrl = '';

/* --------------------------------- status --------------------------------- */

let status: StreamStatus = 'idle';
const statusListeners = new Set<(s: StreamStatus) => void>();
function setStatus(s: StreamStatus): void {
  if (s === status) return;
  status = s;
  for (const cb of statusListeners) cb(s);
}
export function getStreamStatus(): StreamStatus {
  return status;
}
export function subscribeStreamStatus(cb: (s: StreamStatus) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

/* ------------------------------ connect loop ------------------------------ */

function checkpointMsOf(msg: CkptMsg): number | null {
  const ts = msg.checkpoint?.summary?.timestamp;
  if (!ts || ts.seconds == null) return null;
  return Number(ts.seconds) * 1000 + Math.floor((ts.nanos ?? 0) / 1e6);
}

function dispatch(msg: CkptMsg): void {
  if (watchers.size === 0) return;
  const seq = Number(msg.checkpoint?.sequenceNumber ?? msg.cursor ?? -1);
  const ms = checkpointMsOf(msg);
  // Collapse a checkpoint's changed objects to the LATEST version seen per id, then
  // notify each watched id exactly once for this checkpoint.
  const latest = new Map<string, string | undefined>();
  for (const tx of msg.checkpoint?.transactions ?? []) {
    for (const co of tx.effects?.changedObjects ?? []) {
      const id = co.objectId?.toLowerCase();
      if (!id || !watchers.has(id)) continue;
      latest.set(id, co.outputVersion != null ? String(co.outputVersion) : latest.get(id));
    }
  }
  for (const [id, version] of latest) {
    const cbs = watchers.get(id);
    if (!cbs) continue;
    const change: ObjectChange = { version, checkpointMs: ms, seq };
    for (const cb of cbs) {
      try {
        cb(change);
      } catch {
        /* a watcher throwing must never kill the stream */
      }
    }
  }
}

// Only the changed-object IDs + versions + the checkpoint time. Deliberately minimal:
// pulling object contents here stalls the stream (see file header).
const READ_MASK = {
  paths: [
    'sequence_number',
    'summary.timestamp',
    'transactions.effects.changed_objects.object_id',
    'transactions.effects.changed_objects.output_version',
  ],
};

function connect(): void {
  if (!running) return;
  if (isBrowser && document.hidden) {
    // Tab is hidden — don't hold a stream open; resume on visibility.
    setStatus('idle');
    return;
  }
  connectUrl = activeGrpcUrl();
  controller = new AbortController();
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: connectUrl });
  setStatus(status === 'live' ? 'reconnecting' : 'connecting');

  const call = client.subscriptionService.subscribeCheckpoints(
    { readMask: READ_MASK },
    { abort: controller.signal },
  );

  call.responses.onMessage((msg) => {
    backoffMs = 500; // a live message proves the endpoint is good; reset backoff
    setStatus('live');
    dispatch(msg as unknown as CkptMsg);
    // If the health monitor failed us over to a new endpoint, reconnect onto it.
    if (activeGrpcUrl() !== connectUrl) reconnectSoon(0);
  });
  call.responses.onError(() => reconnectSoon(backoffMs));
  call.responses.onComplete(() => reconnectSoon(backoffMs));
}

let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
function reconnectSoon(delay: number): void {
  if (!running) return;
  controller?.abort();
  controller = null;
  if (reconnectTimer) return; // a reconnect is already scheduled
  setStatus('reconnecting');
  backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

function start(): void {
  if (running || !isBrowser) return;
  running = true;
  backoffMs = 500;
  connect();
}

function stop(): void {
  running = false;
  controller?.abort();
  controller = null;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  setStatus('idle');
}

// Pause on tab-hide, resume on show — a background tab needs no live ticks, and this
// releases the streaming connection while away.
if (isBrowser) {
  document.addEventListener('visibilitychange', () => {
    if (!running) return;
    if (document.hidden) {
      controller?.abort();
      controller = null;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      setStatus('idle');
    } else if (!controller && !reconnectTimer) {
      backoffMs = 500;
      connect();
    }
  });
}

/* -------------------------------- public API ------------------------------ */

/**
 * Watch one object id for on-chain changes over the shared checkpoint stream.
 * `cb` fires (at most once per checkpoint) whenever a checkpoint reports the object
 * changed. Returns an unwatch fn; the stream stops once the last watcher unwatches.
 */
export function watchObject(objectId: string, cb: ChangeCb): () => void {
  const id = objectId.toLowerCase();
  let set = watchers.get(id);
  if (!set) {
    set = new Set();
    watchers.set(id, set);
  }
  set.add(cb);
  start();
  return () => {
    const s = watchers.get(id);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) watchers.delete(id);
    if (watchers.size === 0) stop();
  };
}

/** The pyth feed object id for the active deployment (the hot spot-price object). */
export const PYTH_FEED_OBJECT_ID = predictV2Config.asset.pythFeedId;

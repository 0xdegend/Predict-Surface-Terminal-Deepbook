/**
 * lib/sui/v2/event-stream.ts — one shared gRPC EVENT stream that pushes new
 * Predict-package events (order / vault / builder-code) the instant they land, so live
 * views refresh ON the event instead of on a poll tick — letting push carry the freshness
 * the (rate-limited) GraphQL polling used to. See jsonrpc-migration.
 *
 * ⚠️ STATUS (2026-08-13): BUILT + unit-tested but NOT WIRED UP (useV2LiveEvents is not
 * mounted). BLOCKER: the gRPC `subscribeEvents` SERVER-side filter below does not match
 * our Predict package on EITHER endpoint (suiscan or Mysten) — verified via an A/B run
 * where 19 predict events flowed unfiltered while the same-window filtered stream caught
 * 0. It is NOT a type-origin issue (the package is un-upgraded: originalId == storageId ==
 * predict id) and the identical filter DOES work for the propbook package — so it's an
 * endpoint event-index gap for our package. The only working alternatives are (a) drop the
 * server filter and firehose the WHOLE chain (~65 events/s) to the browser and match by
 * package prefix client-side (too heavy, esp. mobile data — fails "no UX impact"), or
 * (b) a server-side event relay (a bigger build). Parked pending that decision; the
 * normalize + targeted-invalidation logic (see use-v2-live-events) is ready either way.
 *
 * Mirrors checkpoint-stream.ts: ONE stream for the whole app, reference-counted (runs only
 * while something watches), auto-reconnect with backoff, pauses while the tab is hidden, and
 * follows the health-aware gRPC endpoint failover. SERVER-side filtered to our package (a DNF
 * EventFilter on the bare package id, which matches every type in it on gRPC), so it carries
 * only our events (a few/sec) — never the whole chain's firehose (~60/sec).
 *
 * It is a SIGNAL, not a source of truth: a watcher learns "a Predict event of this kind
 * touched this market/account" and triggers a TARGETED refetch of the authoritative GraphQL
 * read (which stays the one decode path). Verified live 2026-08-13 that subscribeEvents
 * server-streams over the browser gRPC-Web-over-fetch transport against suiscan with the
 * package filter + a bare-field-name json read-mask.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc';
import { activeGrpcUrl } from '@/lib/sui/grpc';
import { predictV2Config } from '@/config/predict';

/** A normalized Predict event delivered to watchers. */
export interface LiveEvent {
  /** Full Move event type, e.g. `<pkg>::order_events::OrderMinted`. */
  type: string;
  /** Emitting module tail, e.g. `order_events` / `vault_events` / `builder_code_events`. */
  module: string;
  /** Event struct name, e.g. `OrderMinted` (type args stripped). */
  struct: string;
  /** The event's Move struct fields (carries expiry_market_id / account_id / owner …). */
  json: Record<string, unknown>;
  /** Emitting checkpoint sequence, for de-dup / ordering. */
  seq: number;
}

type EventCb = (e: LiveEvent) => void;

const isBrowser = typeof window !== 'undefined';
const watchers = new Set<EventCb>();

/* --------------------------------- status --------------------------------- */

export type StreamStatus = 'idle' | 'connecting' | 'live' | 'reconnecting';
let status: StreamStatus = 'idle';
const statusListeners = new Set<(s: StreamStatus) => void>();
function setStatus(s: StreamStatus): void {
  if (s === status) return;
  status = s;
  for (const cb of statusListeners) cb(s);
}
export function getEventStreamStatus(): StreamStatus {
  return status;
}
export function subscribeEventStreamStatus(cb: (s: StreamStatus) => void): () => void {
  statusListeners.add(cb);
  return () => statusListeners.delete(cb);
}

/* --------------------------- filter / read mask --------------------------- */

/** DNF EventFilter: every event whose TYPE is in the Predict package. One term, one
 *  literal — a bare package id matches any type in it on gRPC (verified live). */
const PREDICT_FILTER = {
  terms: [
    {
      literals: [
        {
          negated: false,
          predicate: {
            oneofKind: 'eventType' as const,
            eventType: { eventType: predictV2Config.packages.predict },
          },
        },
      ],
    },
  ],
};

/** Only the fields we read. Mask paths are the Event's OWN field names (bare — NOT
 *  `event.*`, which the server rejects). */
const READ_MASK = { paths: ['event_type', 'json', 'checkpoint'] };

/* ------------------------------ normalization ----------------------------- */

/** Unwrap a `google.protobuf.Value` (how the raw stream returns Move json) to a plain JS
 *  value. The higher-level core client does this for query reads; the subscription is raw
 *  proto, so we unwrap here. Exported for unit tests. */
export function unwrapValue(v: unknown): unknown {
  const k = (v as { kind?: { oneofKind?: string; [key: string]: unknown } } | null)?.kind;
  if (!k || !k.oneofKind) return undefined;
  switch (k.oneofKind) {
    case 'nullValue':
      return null;
    case 'numberValue':
      return k.numberValue;
    case 'stringValue':
      return k.stringValue;
    case 'boolValue':
      return k.boolValue;
    case 'structValue': {
      const out: Record<string, unknown> = {};
      const fields = (k.structValue as { fields?: Record<string, unknown> })?.fields ?? {};
      for (const [key, val] of Object.entries(fields)) out[key] = unwrapValue(val);
      return out;
    }
    case 'listValue': {
      const values = (k.listValue as { values?: unknown[] })?.values ?? [];
      return values.map(unwrapValue);
    }
    default:
      return undefined;
  }
}

interface EvtMsg {
  event?: { eventType?: string; json?: unknown; checkpoint?: bigint | number };
}

/** Normalize a raw stream frame into a LiveEvent (null for a watermark-only frame).
 *  Exported for unit tests. */
export function normalizeLiveEvent(msg: EvtMsg): LiveEvent | null {
  const ev = msg.event;
  if (!ev?.eventType) return null;
  const type = ev.eventType;
  const parts = type.split('::'); // `<pkg>::module::Struct<...>`
  const mod = parts[1] ?? '';
  const struct = (parts[2] ?? '').split('<')[0];
  const json = (unwrapValue(ev.json) as Record<string, unknown>) ?? {};
  const seq = Number(ev.checkpoint ?? -1);
  return { type, module: mod, struct, json, seq };
}

function dispatch(msg: EvtMsg): void {
  if (watchers.size === 0) return;
  const e = normalizeLiveEvent(msg);
  if (!e) return;
  for (const cb of watchers) {
    try {
      cb(e);
    } catch {
      /* a watcher throwing must never kill the stream */
    }
  }
}

/* ------------------------------ connect loop ------------------------------ */

let controller: AbortController | null = null;
let running = false;
let backoffMs = 500;
const BACKOFF_MAX = 5_000;
let connectUrl = '';
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

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

  const call = client.subscriptionService.subscribeEvents(
    { filter: PREDICT_FILTER, readMask: READ_MASK },
    { abort: controller.signal },
  );

  call.responses.onMessage((msg) => {
    backoffMs = 500; // a live frame proves the endpoint is good; reset backoff
    setStatus('live');
    dispatch(msg as unknown as EvtMsg);
    // If the health monitor failed us over to a new endpoint, reconnect onto it.
    if (activeGrpcUrl() !== connectUrl) reconnectSoon(0);
  });
  call.responses.onError(() => reconnectSoon(backoffMs));
  call.responses.onComplete(() => reconnectSoon(backoffMs));
}

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
 * Watch new Predict-package events over the shared gRPC stream. `cb` fires per matching
 * event. Returns an unwatch fn; the stream stops once the last watcher unwatches.
 */
export function watchPredictEvents(cb: EventCb): () => void {
  watchers.add(cb);
  start();
  return () => {
    watchers.delete(cb);
    if (watchers.size === 0) stop();
  };
}

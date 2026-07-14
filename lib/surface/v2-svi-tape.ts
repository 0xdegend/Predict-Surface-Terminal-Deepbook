/**
 * lib/surface/v2-svi-tape.ts — the v2 surface's SVI HISTORY provider.
 *
 * WHY THIS EXISTS
 * Legacy time-travel replays the indexer's `/oracles/:id/svi` history. The v2
 * deployment has no equivalent (verified live 2026-07-14): the beta server exposes
 * no SVI/pricer history at all, and the propbook spot feed hard-caps at 500 rows
 * (~4 min) with no pagination — `offset`, `before`, `cursor`, `page` are all ignored.
 * The protocol's live SVI exists in exactly one place: the on-chain
 * `load_live_pricer` simulate the surface already polls every few seconds.
 *
 * So we RECORD that tape ourselves. Every live pricer observation is appended here
 * with the time we saw it, and persisted to localStorage so it survives reloads and
 * accumulates across visits. The scrub then replays TRUE snapshots — the exact
 * { forward, SVI } the protocol priced against at that moment — not a reconstruction
 * from today's params. For reference, legacy's own scrub spans only SVI_LIMIT = 80
 * snapshots, which this reaches in ~7 minutes at the surface's 5s poll.
 *
 * THE SEAM
 * The surface consumes only `tapeBounds()` + `tapeSnapshotAt()`. When a server-side
 * SVI history endpoint ships, implement those two over it and delete the recorder —
 * the store, the controls and the canvas do not change.
 *
 * Exposed as an external store (subscribe/getSnapshot) rather than React state: the
 * recorder is a side effect of polling, and useSyncExternalStore lets the surface
 * re-derive its timeline without a setState-in-effect.
 */
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

/** One real observation of a market's pricer. Keys are terse — this persists. */
export interface SviSample {
  /** When we observed it (ms). */
  t: number;
  /** Forward (float $). */
  f: number;
  /** The market's expiry (ms). Carried per-sample so a market that has SINCE
   *  expired still rebuilds correctly when you scrub back to when it was live. */
  e: number;
  /** SVI params packed as [a, b, rho, m, sigma]. */
  p: [number, number, number, number, number];
}

/** marketId → samples, ascending by `t`. */
export type SviTape = Record<string, SviSample[]>;

const KEY = 'v2:svi-tape';
/** Keep an hour of tape — well past any v2 tenor, and small enough for localStorage. */
const MAX_AGE_MS = 60 * 60_000;
/** Per-market cap (an hour at the 5s surface poll ≈ 720; 600 keeps the payload lean). */
const MAX_PER_MARKET = 600;
/** Never record denser than this, so a burst of refetches can't flood the tape. */
const MIN_GAP_MS = 2_000;
/** Below this span the slider is meaningless — the UI shows "recording" instead. */
export const MIN_WINDOW_MS = 30_000;
/** Persist at most this often (localStorage writes are synchronous/blocking). */
const SAVE_EVERY_MS = 10_000;

const EMPTY: SviTape = {};

let tape: SviTape = EMPTY;
let loaded = false;
let lastSaved = 0;
const listeners = new Set<() => void>();

/* ------------------------------ persistence ------------------------------ */

function prune(t: SviTape, now: number): SviTape {
  const out: SviTape = {};
  for (const [id, samples] of Object.entries(t)) {
    const kept = samples.filter((s) => now - s.t <= MAX_AGE_MS).slice(-MAX_PER_MARKET);
    if (kept.length) out[id] = kept;
  }
  return out;
}

function load(): SviTape {
  if (typeof window === 'undefined') return EMPTY;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as SviTape;
    // Trust but verify — a malformed/legacy blob must never crash the surface.
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    return prune(parsed, Date.now());
  } catch {
    return EMPTY;
  }
}

function save(now: number) {
  if (typeof window === 'undefined' || now - lastSaved < SAVE_EVERY_MS) return;
  lastSaved = now;
  try {
    localStorage.setItem(KEY, JSON.stringify(tape));
  } catch {
    // Quota/private mode — the in-memory tape still works for this session.
  }
}

/* --------------------------- external store API --------------------------- */

export function subscribeTape(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Snapshot identity changes only when a new observation lands (see `recordTape`). */
export function getTapeSnapshot(): SviTape {
  if (!loaded && typeof window !== 'undefined') {
    tape = load();
    loaded = true;
  }
  return tape;
}

/** SSR snapshot — the surface is ssr:false, but useSyncExternalStore requires one. */
export function getServerTape(): SviTape {
  return EMPTY;
}

/**
 * Append the current live observations. Skips a market whose newest sample is
 * either too recent (< MIN_GAP_MS) or numerically identical — a repolled pricer
 * that hasn't moved adds no information and would just burn the buffer.
 */
export function recordTape(inputs: SmileInput[], now: number): void {
  if (inputs.length === 0) return;
  const base = getTapeSnapshot();
  let next: SviTape | null = null;

  for (const i of inputs) {
    const id = i.oracle.oracle_id;
    const prev = base[id];
    const last = prev?.[prev.length - 1];
    if (last && (now - last.t < MIN_GAP_MS || (last.f === i.forward && sameSvi(last.p, i.svi)))) continue;
    const sample: SviSample = {
      t: now,
      f: i.forward,
      e: i.oracle.expiry,
      p: [i.svi.a, i.svi.b, i.svi.rho, i.svi.m, i.svi.sigma],
    };
    next ??= { ...base };
    next[id] = [...(next[id] ?? []), sample].slice(-MAX_PER_MARKET);
  }

  if (!next) return; // nothing new — keep the snapshot identity stable
  tape = prune(next, now);
  loaded = true;
  save(now);
  listeners.forEach((l) => l());
}

function sameSvi(p: SviSample['p'], s: SmileInput['svi']): boolean {
  return p[0] === s.a && p[1] === s.b && p[2] === s.rho && p[3] === s.m && p[4] === s.sigma;
}

/* ------------------------------ reads (seam) ------------------------------ */

/** The recorded window, or null while the tape is empty. */
export function tapeBounds(t: SviTape): { tMin: number; tMax: number } | null {
  let tMin = Infinity;
  let tMax = -Infinity;
  for (const samples of Object.values(t)) {
    if (samples.length === 0) continue;
    if (samples[0].t < tMin) tMin = samples[0].t;
    const last = samples[samples.length - 1].t;
    if (last > tMax) tMax = last;
  }
  return Number.isFinite(tMin) && Number.isFinite(tMax) && tMax > tMin ? { tMin, tMax } : null;
}

const lerp = (a: number, b: number, u: number) => a + (b - a) * u;

/**
 * The market's state at `at`, INTERPOLATED between the two observations that
 * bracket it (samples are ascending).
 *
 * Stepping to the latest-at-or-before instead would make the scrub a slideshow:
 * observations land ~5s apart, so dragging would jump the surface discretely from
 * one recording to the next. Blending between them makes the surface a continuous
 * function of time, which is what lets it *flow* under the slider (§10.6 — "this
 * has to be buttery"). The keyframes are real; only the motion between them is
 * smoothed, exactly as a chart interpolates between ticks.
 *
 * `e` (expiry) is fixed for a market, so only the forward and the SVI params blend.
 */
function sampleAt(samples: SviSample[], at: number): SviSample | null {
  let prev: SviSample | null = null;
  let next: SviSample | null = null;
  for (const s of samples) {
    if (s.t <= at) prev = s;
    else {
      next = s;
      break;
    }
  }
  if (!prev) return null; // we weren't recording this market yet
  if (!next) return prev; // at/after the last observation — hold it
  const span = next.t - prev.t;
  if (span <= 0) return prev;
  const u = (at - prev.t) / span;
  const p = prev.p;
  const n = next.p;
  return {
    t: at,
    e: prev.e,
    f: lerp(prev.f, next.f, u),
    p: [
      lerp(p[0], n[0], u),
      lerp(p[1], n[1], u),
      lerp(p[2], n[2], u),
      lerp(p[3], n[3], u),
      lerp(p[4], n[4], u),
    ],
  };
}

/**
 * Rebuild the whole surface as it stood at `at`: per market, its interpolated state.
 * Markets that had already expired at `at` are dropped — their w is frozen while
 * T→0, so IV = √(w/T) explodes and wrecks the mesh's scale. Markets we hadn't
 * started recording yet simply don't appear, which is honest.
 */
export function tapeSnapshotAt(t: SviTape, at: number): SmileInput[] {
  const out: SmileInput[] = [];
  for (const [id, samples] of Object.entries(t)) {
    const s = sampleAt(samples, at);
    if (!s || s.e <= at + 5_000) continue;
    out.push({
      // buildSurface only reads oracle_id / expiry / underlying_asset.
      oracle: { oracle_id: id, expiry: s.e, underlying_asset: 'BTC' } as unknown as Oracle,
      svi: { a: s.p[0], b: s.p[1], rho: s.p[2], m: s.p[3], sigma: s.p[4] },
      forward: s.f,
    });
  }
  return out;
}

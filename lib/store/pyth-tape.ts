/**
 * lib/store/pyth-tape.ts — a module-level rolling buffer of recent BTC spot
 * observations for the price chart's HISTORY line.
 *
 * WHY: the chart's history used to be rebuilt by walking `suix_queryEvents` pages (~10
 * sequential round-trips) on first paint AND re-walked every ~60s to stay current. That
 * is redundant once the Phase 4 checkpoint stream is running: the live pyth reads it
 * drives (kept in `qkV2.pythLatest`) already carry the price every ~second. This buffer
 * accumulates those reads into a rolling per-second tape that SURVIVES the chart
 * unmounting — so switching Surface⇄Chart draws CURRENT history straight from memory
 * with no event walk, and the periodic re-walk is gone. The one-time cold-start walk
 * still seeds it (an empty buffer on a fresh reload can't show the past ~90s yet).
 *
 * Pure module state (no React) so any always-mounted feeder can fill it and the chart
 * can read it at draw time. Bounded to a rolling window so it can never grow unbounded.
 */
import type { PythObservation } from '@/lib/api/v2/types';

/** Keep a bit more than the chart's ~90s display, for margin on the left edge. */
const WINDOW_S = 150;

// second (unix) → the latest observation seen in that second (per-second decimation,
// matching the chart's own toSeries: the chronologically last tick in a second wins).
const bySec = new Map<number, PythObservation>();

/** The observation's own second (Pyth publish time preferred, checkpoint time as
 *  fallback) — the SAME clock the chart uses, so tape points line up with live ticks. */
function obsSec(o: PythObservation): number | null {
  const ms = o.source_timestamp_ms ?? o.checkpoint_timestamp_ms;
  return ms == null ? null : Math.floor(ms / 1000);
}

/** Merge one or more observations into the tape (deduped per second), then prune
 *  anything older than the rolling window. Cheap and idempotent — safe to call on
 *  every live read and on each history backfill. */
export function mergePythTape(obs: PythObservation | PythObservation[] | null | undefined): void {
  if (!obs) return;
  const arr = Array.isArray(obs) ? obs : [obs];
  let newest = -1;
  for (const o of arr) {
    const sec = obsSec(o);
    if (sec == null) continue;
    bySec.set(sec, o); // last write in a second wins
    if (sec > newest) newest = sec;
  }
  if (newest < 0) return;
  const cutoff = newest - WINDOW_S;
  for (const sec of bySec.keys()) if (sec < cutoff) bySec.delete(sec);
}

/** The tape as an ascending observation array (empty until it has been fed). */
export function getPythTape(): PythObservation[] {
  return [...bySec.entries()].sort((a, b) => a[0] - b[0]).map(([, o]) => o);
}

/** Distinct-second points currently held — lets a caller tell a warm tape from a cold
 *  one without materializing the whole array. */
export function pythTapeSize(): number {
  return bySec.size;
}

/** Testing/reset hook — clears the buffer. */
export function _resetPythTape(): void {
  bySec.clear();
}

'use client';

/**
 * useV2SurfaceInputs — LIVE + time-travel data for the v2 surface, the analogue of
 * legacy's use-surface-inputs.
 *
 * Legacy fetches SVI history from the indexer; v2 has no such endpoint, so we record
 * the live pricer tape ourselves (lib/surface/v2-svi-tape.ts) and replay it. Both
 * paths end in the same place: SmileInput[] for a given moment.
 *
 *  - LIVE  → the polled pricers, straight through.
 *  - SCRUB → tapeSnapshotAt(t): per market, the newest REAL observation at-or-before t.
 *
 * `displayNow` is the clock the surface must be built against. This matters far more
 * in v2 than in legacy: v2 markets roll every ~minute, so a surface rewound even a
 * few minutes contains markets that have since expired. Building them against the
 * real `now` would drive T→0 and blow IV = √(w/T) up to infinity. Callers MUST pass
 * displayNow into buildSurface as `nowMs`.
 */
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { buildSurface, type SmileInput } from '@/lib/svi/surface';
import { buildSurfaceMesh } from '@/lib/svi/mesh';
import { useV2SurfaceStore } from '@/lib/store/v2-surface-store';
import { useSmoothScrub } from '@/lib/hooks/use-smooth-scrub';
import {
  subscribeTape,
  getTapeSnapshot,
  getServerTape,
  recordTape,
  tapeBounds,
  tapeSnapshotAt,
  MIN_WINDOW_MS,
} from '@/lib/surface/v2-svi-tape';

/** The k-grid the caller builds its surface on — mirrored here so the pinned IV
 *  ruler is measured on exactly the same geometry the canvas renders. */
export interface V2SurfaceOpts {
  kMin: number;
  kMax: number;
  kSteps: number;
}

/** How many moments across the window to sample when pinning the IV ruler. */
const IV_RANGE_SAMPLES = 9;

export interface V2SurfaceData {
  /** The surface to render — live pricers, or the rewound snapshot. */
  inputs: SmileInput[];
  isLive: boolean;
  /** Recorded window (ms), null until anything is on tape. */
  timeline: { tMin: number; tMax: number } | null;
  /** The moment being displayed. */
  currentTime: number;
  /** Enough tape to make the slider meaningful. */
  historyReady: boolean;
  /** Clock to build the surface against — the scrub time when rewound. */
  displayNow: number;
  /**
   * While rewound: a FIXED IV window spanning the whole recording, to pass as
   * MeshOptions.ivRange. Without it the mesh auto-ranges to each frame's own data,
   * re-fitting the surface to the display box every frame — which normalizes the vol
   * level away, so the surface looks rigid and merely shifts as a block. Undefined
   * while live (auto-range is correct there). Sampled across the window so a past
   * surface never clips against the ruler.
   */
  ivRange?: { min: number; max: number };
}

export function useV2SurfaceInputs(
  liveInputs: SmileInput[],
  nowMs: number,
  opts: V2SurfaceOpts,
): V2SurfaceData {
  const mode = useV2SurfaceStore((s) => s.mode);
  const scrub = useV2SurfaceStore((s) => s.scrub);
  const pendingLive = useV2SurfaceStore((s) => s.pendingLive);
  const goLive = useV2SurfaceStore((s) => s.goLive);
  const scrubSession = useV2SurfaceStore((s) => s.scrubSession);

  // The surface follows the slider through an eased, speed-capped follower — a fast
  // fling of the thumb must not fling the 3-D with it. THIS, not `scrub`, is the
  // position we render at.
  const position = useSmoothScrub(scrub, mode === 'scrub');

  // The tape is an external store: recording is a side effect of polling, and its
  // snapshot identity only changes when a new observation actually lands.
  const tape = useSyncExternalStore(subscribeTape, getTapeSnapshot, getServerTape);

  // Capture every fresh live observation. Pure side effect — the store notifies.
  useEffect(() => {
    recordTape(liveInputs, Date.now());
  }, [liveInputs]);

  // Returning to live is a glide, not a cut: hitting Live aims the follower at the
  // newest frame, and only once the surface has actually arrived do we hand over to
  // the streaming inputs — so the handoff is invisible instead of a jump.
  useEffect(() => {
    if (pendingLive && mode === 'scrub' && position > 0.999) goLive();
  }, [pendingLive, mode, position, goLive]);

  const bounds = useMemo(() => tapeBounds(tape), [tape]);
  const historyReady = !!bounds && bounds.tMax - bounds.tMin >= MIN_WINDOW_MS;
  const rewound = mode === 'scrub' && !!bounds && historyReady;

  // Pin the IV ruler while rewound, so every frame is measured on one fixed scale
  // (see V2SurfaceData.ivRange). We sample moments across the window, build each
  // through buildSurfaceMesh — inheriting exactly the auto-range the LIVE surface
  // would have used at that moment — and take the MEDIAN of those ranges.
  //
  // Median, not the union: v2 markets roll every minute, so some moments contain a
  // market seconds from expiry whose wings blow up (IV = √(w/T)). Taking the union
  // let one such moment drag the ceiling far above the real market, which squashed
  // every other frame into the bottom of the ramp. The median is the ruler a TYPICAL
  // moment would have used, so a rewound surface reads like the live one — just on a
  // scale that holds still. A rare extreme frame saturates, exactly as it does live.
  // FROZEN PER SESSION. Keyed on `scrubSession`, deliberately NOT on `tape`/`bounds`:
  // the tape keeps recording while you rewind, so re-deriving the ruler off a growing
  // window shifted the scale under the surface every few seconds — the whole model
  // rose and then settled. It's captured once, when you leave the live stream.
  const ivRange = useMemo(() => {
    if (!rewound || !bounds) return undefined;
    const span = bounds.tMax - bounds.tMin;
    const mins: number[] = [];
    const maxes: number[] = [];
    for (let i = 0; i < IV_RANGE_SAMPLES; i++) {
      const t = bounds.tMin + (span * i) / (IV_RANGE_SAMPLES - 1);
      const snap = tapeSnapshotAt(tape, t);
      if (snap.length === 0) continue;
      const m = buildSurfaceMesh(buildSurface(snap, { ...opts, nowMs: t }));
      mins.push(m.ivMin);
      maxes.push(m.ivMax);
    }
    if (mins.length === 0) return undefined;
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
    const min = median(mins);
    const max = median(maxes);
    return Number.isFinite(min) && Number.isFinite(max) && max > min ? { min, max } : undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- frozen per scrub session on purpose (see above)
  }, [scrubSession, rewound, opts]);

  return useMemo(() => {
    if (rewound && bounds) {
      const t = bounds.tMin + (bounds.tMax - bounds.tMin) * position;
      return {
        inputs: tapeSnapshotAt(tape, t),
        isLive: false,
        timeline: bounds,
        currentTime: t,
        historyReady: true,
        displayNow: t,
        ivRange,
      };
    }

    return {
      inputs: liveInputs,
      isLive: true,
      timeline: bounds,
      currentTime: nowMs,
      historyReady,
      displayNow: nowMs,
    };
  }, [tape, rewound, bounds, historyReady, position, liveInputs, nowMs, ivRange]);
}

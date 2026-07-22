'use client';

/**
 * SurfaceCanvasV2 — the live SVI vol surface for the new deployment, at legacy
 * parity as a full trading instrument (X = log-moneyness, Z = expiry depth,
 * Y/colour = IV; pure math shared via buildSurface + buildSurfaceMesh):
 *
 *  - MORPH: one persistent geometry eases toward each new target every frame,
 *    so data refreshes, the Stress bend and the Arb Check repaint all animate
 *    instead of snapping, and the surface assembles upward on load (§10.6).
 *  - TRADE: hover a node for odds (pointer/not-allowed cursor feedback + dead-
 *    zone note in the tooltip); click opens the quick-mint popover (glance →
 *    ticket → mint) pre-filled through the shared v2 trade store, and range
 *    mode builds a band from two clicks. Below lg the surface is VIEW-ONLY —
 *    trading happens from the rail/list (a 3-D tap on a phone is imprecise).
 *  - OVERLAYS: Arb Check paints butterfly/calendar-violating cells red on the
 *    mesh (plus the status pill), Stress injects one localized sample mispricing
 *    (at the live IV scale) so the checker visibly fires; the popover always
 *    prices off the UNSTRESSED live inputs.
 *  - Legacy extras: first-run coach pulse, mode-aware tap hint, and a fill
 *    ripple on every successful mint (popover or rail ticket).
 *
 * Not yet ported: LIVE/time-travel scrub (needs a per-market SVI history the v2
 * data path doesn't expose today).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Html, Line, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { buildSurface, type SmileInput, type Surface } from '@/lib/svi/surface';
import { buildSurfaceMesh, ivColor, type SurfaceMesh } from '@/lib/svi/mesh';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useV2SurfaceStore } from '@/lib/store/v2-surface-store';
import { useV2SurfaceInputs } from '@/lib/hooks/use-v2-surface-inputs';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useNow } from '@/lib/hooks/use-now';
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { price, pct, signed, dateUTC, ttl, timeUTC } from '@/lib/format';
import { InfoTip } from '@/app/_components/ui/info-tip';
import { LuBoxes, LuMoveHorizontal, LuMoveDiagonal, LuMoveVertical } from 'react-icons/lu';
import type { IconType } from 'react-icons';
import { SurfaceTradePopoverV2 } from './surface-trade-popover';
import { usePredictAccountV2 } from '@/lib/hooks/use-predict-account-v2';
import { useV2PortfolioPositions } from '@/lib/hooks/use-v2-portfolio-positions';
import type { V2PortfolioPosition } from '@/lib/portfolio/v2';
import type { V2Market } from '@/lib/api/v2/types';

/**
 * Per-frame smoothing constants for the geometry morph (`a = 1 - ease^delta`), so
 * LOWER = snappier.
 *
 * LIVE catches up fast — a data refresh should land, not drift.
 *
 * TIME TRAVEL is only *slightly* gentler, and deliberately so: the scrub's real
 * smoothing lives upstream in useSmoothScrub (an eased, speed-capped follower), so
 * the mesh is already being handed a calm, continuous target. Piling heavy damping
 * on top of that would just make the surface feel mushy and lag the slider.
 */
const LIVE_EASE = 0.0008;
const SCRUB_EASE = 0.004;

/**
 * The k-grid the surface is built on: 49 cols over ±0.06 log-moneyness — half
 * legacy's ±0.12 window, sized to v2's short tenors (≤8h), whose tradeable band only
 * spans |k| ≲ 0.035. At ±0.12 three quarters of every row was dead zone and the
 * surface read as two pale slabs; at ±0.06 the glowing ridge fills the canvas.
 *
 * Module-level (not inline) so its identity is stable: it's a memo dependency, and
 * it's also handed to useV2SurfaceInputs so the pinned IV ruler is measured on
 * exactly the geometry we render.
 */
const K_GRID = { kMin: -0.06, kMax: 0.06, kSteps: 49 } as const;

interface HoverInfo {
  x: number; // canvas-relative px
  y: number;
  strike: number;
  expiry: number;
  iv: number;
  up: number;
  tradeable: boolean;
}

/** Nearest (row, col) grid node to a picked/hovered 3-D point. */
function nearestCell(mesh: SurfaceMesh, p: THREE.Vector3): { row: number; col: number } {
  const nearest = (arr: number[], v: number) => {
    let best = Infinity;
    let idx = 0;
    arr.forEach((x, i) => {
      const d = Math.abs(x - v);
      if (d < best) {
        best = d;
        idx = i;
      }
    });
    return idx;
  };
  return {
    col: nearest(mesh.colMeta.map((c) => c.x), p.x),
    row: nearest(mesh.rowMeta.map((r) => r.z), p.z),
  };
}

/** The ticket's current pick resolved to absolute strikes on a surface row. */
type SurfaceSelection =
  | { kind: 'binary'; oracleId: string; strike: number; isUp: boolean }
  | { kind: 'range'; oracleId: string; lower: number; higher: number };

export function SurfaceCanvasV2({
  inputs,
  markets,
  serverNow,
}: {
  inputs: SmileInput[];
  markets: V2Market[];
  serverNow: number;
}) {
  const [stress, setStress] = useState(false);
  const [showNoArb, setShowNoArb] = useState(false);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  // Below lg the surface is VIEW-ONLY — trading happens from the rail/list
  // (legacy parity: a 3-D tap on a phone is imprecise).
  const isMobile = useMediaQuery('(max-width: 1023px)');

  // Click-to-mint popover centered over the surface (desktop only). `clickId`
  // remounts it on each new pick so its internal glance/ticket state resets.
  const [popover, setPopover] = useState(false);
  const [clickId, setClickId] = useState(0);

  // First-run coach mark — same key as legacy (the "tap the surface to trade"
  // lesson is identical across deployments). localStorage is safe at init: this
  // canvas is dynamically imported ssr:false, so `window` exists.
  const [coachSeen, setCoachSeen] = useState(() => {
    try {
      return localStorage.getItem('skew:surface-coach-seen') === '1';
    } catch {
      return false;
    }
  });
  function markCoachSeen() {
    if (coachSeen) return;
    try {
      localStorage.setItem('skew:surface-coach-seen', '1');
    } catch {
      /* private mode — just hide for this session */
    }
    setCoachSeen(true);
  }

  // Live wall-clock for tenor (legacy parity — the old frozen `serverNow` left
  // tYears at their page-load values forever). Quantized to 10s so the clock
  // alone rebuilds the mesh at most every 10s; pricer refreshes drive the rest.
  const now = useNow(serverNow);
  const nowMs = now - (now % 10_000);

  // Ticket selection (strike offset / range band, in admission steps from ATM)
  // resolved to absolute strikes against the selected market's surface row, so
  // the pick renders ON the surface and tracks slider/odds-curve drags live —
  // legacy parity (SelectedMarker / BinaryWinZone / RangeBandMarker).
  const marketId = useV2TradeStore((s) => s.marketId);
  const mode = useV2TradeStore((s) => s.mode);
  const isUp = useV2TradeStore((s) => s.isUp);
  const strikePrice = useV2TradeStore((s) => s.strikePrice);
  const rangeLowerPrice = useV2TradeStore((s) => s.rangeLowerPrice);
  const rangeHigherPrice = useV2TradeStore((s) => s.rangeHigherPrice);
  const rangeAnchorPrice = useV2TradeStore((s) => s.rangeAnchorPrice);
  const pickSeq = useV2TradeStore((s) => s.pickSeq);
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setStrikePrice = useV2TradeStore((s) => s.setStrikePrice);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const pickRangeLevel = useV2TradeStore((s) => s.pickRangeLevel);
  const clearRange = useV2TradeStore((s) => s.clearRange);

  // The connected account's OPEN bets, pinned onto the surface at their
  // (market, strike) so a trader watches them ride the landscape. Same query
  // key as the positions rail → TanStack dedupes it to zero extra fetches.
  // Only binary, still-open, non-sample rows on a live market get a pin (range
  // bands + settled bets are excluded; `locate` drops any whose market isn't a
  // surface row). Gated to the live surface below (not stress/scrub previews).
  const acct = usePredictAccountV2();
  const { positions: accountPositions } = useV2PortfolioPositions(acct.accountId);
  const positionPins = useMemo(
    () =>
      accountPositions.filter(
        (p) => !p.settled && p.qty > 0 && !p.sample && p.direction !== 'Range' && p.marketId != null && p.strike != null,
      ),
    [accountPositions],
  );

  // Drop rows at/past expiry: their w is frozen while T clamps to ~0, so
  // IV = √(w/T) explodes and the height/colour normalization pancakes every
  // other row until the market poll prunes the dead market.
  const liveInputs = useMemo(
    () => inputs.filter((i) => i.oracle.expiry > nowMs + 5_000),
    [inputs, nowMs],
  );

  // LIVE vs time-travel. The hook records every live observation to the SVI tape
  // (v2 has no server-side SVI history — see lib/surface/v2-svi-tape.ts) and, while
  // scrubbing, replays the real snapshot at that moment. `displayNow` is the clock
  // the surface must be built against: v2 markets roll every ~minute, so a rewound
  // surface holds markets that have since expired — against the real `now` their
  // T→0 and IV = √(w/T) would explode. `ivRange` pins the IV ruler while rewound.
  const { inputs: shownInputs, isLive, currentTime, historyReady, displayNow, ivRange } =
    useV2SurfaceInputs(liveInputs, nowMs, K_GRID);
  // Stress is DISPLAY-ONLY: buildSurface keeps the whole surface at the live IV
  // scale and injects ONE localized sample mispricing (a gentle kink + a real
  // no-arb violation) so the checker fires while the surface still reads real —
  // NOT a global perturbation, which pinned every short-tenor row to the display
  // ceiling and flattened it into a red plateau. The popover always prices off
  // the unstressed `liveInputs`.
  const surface = useMemo(
    () => buildSurface(shownInputs, { ...K_GRID, nowMs: displayNow, stress }),
    [shownInputs, displayNow, stress],
  );
  // While rewound, measure every frame on the SAME pinned IV ruler — otherwise the
  // mesh re-fits itself to the display box each frame and the vol level's rise and
  // fall is normalized straight back out (the surface then only appears to shift as
  // a block). Live keeps auto-ranging, which is what makes it always read at full drama.
  const mesh = useMemo(
    () => buildSurfaceMesh(surface, ivRange ? { ivRange } : undefined),
    [surface, ivRange],
  );

  const selection = useMemo<SurfaceSelection | null>(() => {
    if (!marketId) return null;
    const market = markets.find((m) => m.expiry_market_id === marketId);
    const row = surface.rows.find((r) => r.oracleId === marketId);
    if (!market || !row) return null; // selected market isn't on the surface (no seed row)
    const atm = toFloat(snapStrikeToAdmission(fromFloat(row.forward), BigInt(market.admission_tick_size)));
    if (mode === 'range') {
      if (rangeLowerPrice == null || rangeHigherPrice == null) return null;
      return { kind: 'range', oracleId: marketId, lower: rangeLowerPrice, higher: rangeHigherPrice };
    }
    // Absolute strike (pinned); default to ATM until picked.
    return { kind: 'binary', oracleId: marketId, strike: strikePrice ?? atm, isUp };
  }, [marketId, markets, surface, mode, isUp, strikePrice, rangeLowerPrice, rangeHigherPrice]);

  const { hasButterfly, hasCalendar } = surface;
  const bandSet = rangeLowerPrice != null && rangeHigherPrice != null;

  // The market/input the popover trades — the store's selected market, priced
  // off the UNSTRESSED live inputs (the mint guards must see real odds).
  const activeMarket = useMemo(
    () => (marketId ? (markets.find((m) => m.expiry_market_id === marketId) ?? null) : null),
    [markets, marketId],
  );
  const activeInput = useMemo(
    () => (marketId ? (liveInputs.find((i) => i.oracle.oracle_id === marketId) ?? null) : null),
    [liveInputs, marketId],
  );

  // Turning Stress on makes the surface a deliberately-falsified diagnostic view
  // (fabricated arb), so trading off it is gated — close any open ticket and drop
  // an in-progress range draw so the camera unfreezes.
  function toggleStress(v: boolean) {
    setStress(v);
    if (v) {
      setPopover(false);
      clearRange();
    }
  }

  function pick(row: number, col: number) {
    // Surface is view-only below lg — trade from the rail/list instead.
    if (isMobile) return;
    // Stress is a preview of a mispriced surface — not tradeable. Turn it off.
    if (stress) return;
    // A rewound surface shows odds that are no longer for sale — go Live to trade.
    if (!isLive) return;
    const sRow = surface.rows[row];
    const cell = sRow?.cells[col];
    // Dead-zone nodes (fair UP outside the mintable band) are dimmed and not
    // mintable — ignore the click rather than load a doomed ticket.
    if (!sRow || !cell || !cell.tradeable) return;
    const clickedMarket = markets.find((m) => m.expiry_market_id === sRow.oracleId);
    if (!clickedMarket) return;
    markCoachSeen(); // first real interaction — retire the coach mark for good
    // The actual price the user pointed at (this node's strike).
    const clickedPrice = sRow.forward * Math.exp(cell.k);

    if (mode === 'range') {
      // A range lives on ONE market (one expiry = one row): once a first edge is
      // anchored we KEEP the band on the anchor's market and treat this click as
      // just the PRICE of the second edge (legacy parity — two 3-D picks almost
      // never land on the same row).
      const st = useV2TradeStore.getState();
      let targetMarket = clickedMarket;
      let targetRow: Surface['rows'][number] = sRow;
      if (st.rangeAnchorPrice != null && st.marketId) {
        const aRow = surface.rows.find((r) => r.oracleId === st.marketId);
        const aMarket = markets.find((m) => m.expiry_market_id === st.marketId);
        if (aRow && aMarket) {
          targetMarket = aMarket;
          targetRow = aRow;
        }
      } else if (st.marketId !== clickedMarket.expiry_market_id) {
        selectMarket(clickedMarket.expiry_market_id); // fresh band on the clicked market
      }
      const step = toFloat(targetMarket.admission_tick_size) || 1;
      const atm = toFloat(
        snapStrikeToAdmission(fromFloat(targetRow.forward), BigInt(targetMarket.admission_tick_size)),
      );
      pickRangeLevel(atm + Math.round((clickedPrice - atm) / step) * step);
      // Open the card only once this click COMPLETES the band — keep the surface
      // clear for the second pick (legacy parity).
      const after = useV2TradeStore.getState();
      if (after.rangeLowerPrice != null && after.rangeHigherPrice != null) {
        setPopover(true);
        setClickId((n) => n + 1);
      }
      return;
    }

    // Binary: the clicked node is the strike directly.
    const step = toFloat(clickedMarket.admission_tick_size) || 1;
    const atm = toFloat(
      snapStrikeToAdmission(fromFloat(sRow.forward), BigInt(clickedMarket.admission_tick_size)),
    );
    selectMarket(clickedMarket.expiry_market_id);
    setStrikePrice(atm + Math.round((clickedPrice - atm) / step) * step);
    // A surface pick is a full side-&-level choice — advance the rail ticket to
    // its bet step (legacy parity).
    markPicked();
    setPopover(true);
    setClickId((n) => n + 1); // remount so glance/size reset on each new pick
  }

  // "Committed to a pick" — the ticket is open, or a range's first edge is placed
  // and the second click is still pending. While true, the camera is frozen (no
  // zoom/orbit) so an aimed click can't be thrown off by the model moving.
  const interacting = popover || rangeAnchorPrice != null;

  // A surface needs ≥2 live expiries; between market rolls the filter can briefly
  // leave fewer, and an early stretch of tape may not have two markets recorded yet.
  // Hold a quiet placeholder rather than a broken mesh — but KEEP the controls
  // mounted, or scrubbing into a thin patch would strand the user with no Live button.
  if (surface.rows.length < 2) {
    return (
      <div className="relative flex h-full w-full items-center justify-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-3">
          {isLive ? 'waiting for live markets…' : 'nothing recorded at this moment'}
        </span>
        <SurfaceControls
          isLive={isLive}
          currentTime={currentTime}
          historyReady={historyReady}
          showNoArb={showNoArb}
          onNoArb={() => setShowNoArb((v) => !v)}
          stress={stress}
          onStress={toggleStress}
        />
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <Canvas
        // Pulled ~17% closer than legacy's [8, 7.5, 12.5] so the surface reads
        // bigger/nearer at rest (same viewing angle; still inside the
        // min/maxDistance band so the user can zoom out freely).
        camera={{ position: [6.6, 6.2, 10.4], fov: 38 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <color attach="background" args={['#0A0B0D']} />
        {/* Brighter than legacy's exact values — v2's short-tenor data is flatter,
            so it needs more light to read as luminous. Hemisphere adds an even,
            cool-tinted fill that lifts the shadowed floor and saturates the ramp. */}
        <ambientLight intensity={0.7} />
        <hemisphereLight args={['#cfe6ff', '#0a1620', 0.5]} />
        <directionalLight position={[6, 12, 8]} intensity={1.5} />
        <directionalLight position={[-8, 5, -6]} intensity={0.5} color="#6fb7ff" />
        <group position={[0, -1.4, 0]}>
          <MorphSurface
            surface={surface}
            mesh={mesh}
            showNoArb={showNoArb}
            reduced={reduced}
            onHover={setHover}
            onPick={pick}
            disabled={stress || !isLive}
            ease={isLive ? LIVE_EASE : SCRUB_EASE}
          />
          <SurfaceAxes mesh={mesh} now={displayNow} />
          {selection?.kind === 'binary' && (
            <>
              <BinaryWinZone mesh={mesh} surface={surface} sel={selection} />
              <SelectedMarker mesh={mesh} surface={surface} sel={selection} />
            </>
          )}
          {selection?.kind === 'range' && <RangeBandMarker mesh={mesh} surface={surface} sel={selection} />}
          {/* Your open bets, living on the surface — only on the real live
              surface (a stress/scrub preview isn't where your money sits). */}
          {isLive && !stress && positionPins.length > 0 && (
            <SurfacePositionPins mesh={mesh} surface={surface} positions={positionPins} />
          )}
          <FillRipple mesh={mesh} surface={surface} />
          <FirstRunPulse
            mesh={mesh}
            surface={surface}
            reduced={reduced}
            show={!isMobile && !coachSeen && pickSeq === 0 && !popover && !stress}
          />
          <Grid
            args={[mesh.width + 2, mesh.depth + 2]}
            cellSize={0.5}
            cellThickness={0.7}
            cellColor="#22262c"
            sectionSize={2}
            sectionThickness={1.2}
            sectionColor="#2d333a"
            fadeDistance={28}
            fadeStrength={1.5}
            position={[0, -0.02, 0]}
          />
        </group>
        <OrbitControls
          enablePan={false}
          // Freeze zoom + orbit while the user is committed to a pick — the ticket
          // is open, or a range's first edge is set and they're aiming the second.
          // Holding the model dead-still makes the click land where they aim;
          // passive hovering still allows zoom/orbit to explore. (Pan is always off;
          // autoRotate already pauses on these states + hover.)
          enableZoom={!interacting}
          enableRotate={!interacting}
          autoRotate={isLive && !hover && !reduced && !popover && rangeAnchorPrice == null}
          autoRotateSpeed={0.1}
          minDistance={8}
          maxDistance={22}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, -0.5, 0]}
        />
      </Canvas>

      {hover && !popover && <SurfaceTooltip hover={hover} />}

      {/* While a range band is still being drawn (no finalized band yet), never
          mount the card — it would cover the surface and block the second pick;
          the bottom hint guides until both edges are set (legacy parity). */}
      {popover && !stress && isLive && !(mode === 'range' && !bandSet) && (
        <SurfaceTradePopoverV2
          key={clickId}
          market={activeMarket}
          input={activeInput}
          now={now}
          onClose={() => setPopover(false)}
        />
      )}
      <SurfaceLegend ivMin={mesh.ivMin} ivMax={mesh.ivMax} />
      <SurfaceMeta
        expiries={surface.rows.length}
        hasButterfly={hasButterfly}
        hasCalendar={hasCalendar}
        showNoArb={showNoArb}
      />
      <SurfaceControls
        isLive={isLive}
        currentTime={currentTime}
        historyReady={historyReady}
        showNoArb={showNoArb}
        onNoArb={() => setShowNoArb((v) => !v)}
        stress={stress}
        onStress={toggleStress}
      />

      {/* Plain-English "how to read the surface" guide. Kept mounted but suppressed
          while the trade popover is open, so its collapse state survives. */}
      <SurfaceCaption suppressed={popover} />

      {/* Tap-to-trade hint — desktop only (the surface is view-only below lg).
          While Stress is on the surface is a preview and trading is gated, so
          swap in a note that says so; otherwise it's mode-aware and fades out
          once the relevant pick is made (legacy parity). */}
      {!isLive ? (
        <div className="pointer-events-none absolute bottom-19 left-1/2 hidden -translate-x-1/2 lg:block">
          <span className="chip h-7 px-3 text-[11px] text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-warn" />
            Drag slowly to morph the surface — hit Live to trade
          </span>
        </div>
      ) : stress ? (
        <div className="pointer-events-none absolute bottom-19 left-1/2 hidden -translate-x-1/2 lg:block">
          <span className="chip h-7 px-3 text-[11px] text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-down" />
            Stress is a preview — turn it off to trade
          </span>
        </div>
      ) : (
        <div
          className={`pointer-events-none absolute bottom-19 left-1/2 hidden -translate-x-1/2 transition-all duration-300 lg:block ${
            (mode === 'range' ? bandSet : pickSeq > 0) ? 'translate-y-1 opacity-0' : 'opacity-100'
          }`}
        >
          <span className="chip h-7 px-3 text-[11px] text-text-2">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" />
            {mode === 'range'
              ? rangeAnchorPrice != null && !bandSet
                ? 'Tap the second price level to set your range'
                : 'Tap two price levels to set your range'
              : 'Tap a point on the surface to build a trade'}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * MorphSurface — persistent geometry that eases toward the target mesh each
 * frame (legacy port): live data refreshes, the Stress bend and the Arb Check
 * repaint all ANIMATE instead of snapping, and on first mount (or when the
 * market roster changes topology) the surface assembles upward from the floor.
 */
function MorphSurface({
  surface,
  mesh,
  showNoArb,
  reduced,
  onHover,
  onPick,
  disabled = false,
  ease = LIVE_EASE,
}: {
  surface: Surface;
  mesh: SurfaceMesh;
  showNoArb: boolean;
  reduced: boolean;
  onHover: (h: HoverInfo | null) => void;
  onPick: (row: number, col: number) => void;
  disabled?: boolean;
  /** Per-frame smoothing constant (see LIVE_EASE / SCRUB_EASE). Lower = snappier. */
  ease?: number;
}) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  // Arb overlay (legacy parity): with Arb Check on, butterfly/calendar-violating
  // cells paint red on the mesh itself rather than as separate markers — and the
  // repaint rides the same per-frame color lerp as everything else.
  const targetColors = useMemo(() => {
    if (!showNoArb || mesh.violations.length === 0) return mesh.colors;
    const c = mesh.colors.slice();
    for (const v of mesh.violations) {
      const idx = (v.row * mesh.cols + v.col) * 3;
      c[idx] = 0.95;
      c[idx + 1] = 0.22;
      c[idx + 2] = 0.19;
    }
    return c;
  }, [mesh, showNoArb]);

  const topoKey = `${mesh.rows}x${mesh.cols}`;
  // A new geometry starts AT its target height; the per-frame lerp below carries it
  // from there. The row count changes whenever a market rolls off — and while time
  // travelling you cross those boundaries constantly — so rebuilding flat each time
  // collapsed the whole surface and slammed it back up. That was the single most
  // distracting thing about the scrub. The upward assembly is a ONE-TIME load
  // flourish, applied below instead of on every rebuild.
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(targetColors.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey]);

  useEffect(() => () => geom.dispose(), [geom]);

  // The load choreography (§10.6): flatten the FIRST geometry so the surface
  // assembles upward on the opening frames. Layout effect so it lands before paint,
  // and guarded by a ref so a later topology change never repeats it.
  const assembled = useRef(false);
  useLayoutEffect(() => {
    if (reduced || assembled.current) return;
    assembled.current = true;
    const attr = geom.getAttribute('position') as THREE.BufferAttribute;
    const pos = attr.array as Float32Array;
    for (let i = 1; i < pos.length; i += 3) pos[i] = 0;
    attr.needsUpdate = true;
  }, [geom, reduced]);

  const target = useRef({ positions: mesh.positions, colors: targetColors });
  useEffect(() => {
    target.current = { positions: mesh.positions, colors: targetColors };
  }, [mesh, targetColors]);

  useFrame((state, delta) => {
    const posAttr = geom.getAttribute('position') as THREE.BufferAttribute;
    const colAttr = geom.getAttribute('color') as THREE.BufferAttribute;
    const pos = posAttr.array as Float32Array;
    const col = colAttr.array as Float32Array;
    const tp = target.current.positions;
    const tc = target.current.colors;
    if (pos.length !== tp.length) return;
    const a = reduced ? 1 : 1 - Math.pow(ease, delta);
    let moved = false;
    for (let i = 0; i < pos.length; i++) {
      const dp = tp[i] - pos[i];
      if (Math.abs(dp) > 1e-5) {
        pos[i] += dp * a;
        moved = true;
      }
      col[i] += (tc[i] - col[i]) * a;
    }
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    if (moved) geom.computeVertexNormals();
    // The surface is the only element that glows (design brief) — a slow
    // emissive breath, off under prefers-reduced-motion.
    if (matRef.current && !reduced) {
      matRef.current.emissiveIntensity = 0.18 + 0.05 * Math.sin(state.clock.elapsedTime * 0.8);
    }
  });

  function handleMove(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation();
    const { row, col } = nearestCell(mesh, e.point);
    const sRow = surface.rows[row];
    const cell = sRow?.cells[col];
    if (!sRow || !cell) return;
    // Pointer over a mintable node, not-allowed over the dead zone (legacy
    // parity) — the cursor is the first "you can trade this" signal. While Stress
    // gates trading, keep the default cursor so nothing reads as clickable.
    if (typeof document !== 'undefined') {
      document.body.style.cursor = disabled ? 'default' : cell.tradeable ? 'pointer' : 'not-allowed';
    }
    onHover({
      x: e.nativeEvent.offsetX,
      y: e.nativeEvent.offsetY,
      strike: sRow.forward * Math.exp(cell.k),
      expiry: sRow.expiry,
      iv: cell.iv,
      up: cell.up,
      tradeable: cell.tradeable,
    });
  }

  return (
    <group>
      <mesh
        geometry={geom}
        onPointerMove={handleMove}
        onPointerOut={() => {
          if (typeof document !== 'undefined') document.body.style.cursor = '';
          onHover(null);
        }}
        onClick={(e) => {
          e.stopPropagation();
          const { row, col } = nearestCell(mesh, e.point);
          onPick(row, col);
        }}
      >
        <meshStandardMaterial
          ref={matRef}
          vertexColors
          side={THREE.DoubleSide}
          roughness={0.4}
          metalness={0.1}
          emissive={new THREE.Color('#0d2b33')}
          emissiveIntensity={0.18}
        />
      </mesh>
      {/* faint wireframe overlay — the fine grid lines on the ridge */}
      <mesh geometry={geom} raycast={() => null}>
        <meshBasicMaterial wireframe transparent opacity={0.1} color="#ffffff" />
      </mesh>
    </group>
  );
}

/** Map an (oracle, strike) to its nearest grid cell — world xyz + row/col so
 *  callers can sample neighbouring columns (the win-zone ribbon needs the span). */
function locateCell(
  mesh: SurfaceMesh,
  surface: Surface,
  oracleId: string,
  strike: number,
): { x: number; y: number; z: number; row: number; col: number } | null {
  const row = surface.rows.findIndex((r) => r.oracleId === oracleId);
  if (row < 0) return null;
  const r = surface.rows[row];
  const k = Math.log(strike / r.forward);
  let col = 0;
  let best = Infinity;
  for (let c = 0; c < surface.kGrid.length; c++) {
    const d = Math.abs(surface.kGrid[c] - k);
    if (d < best) {
      best = d;
      col = c;
    }
  }
  const idx = (row * mesh.cols + col) * 3;
  return { x: mesh.positions[idx], y: mesh.positions[idx + 1], z: mesh.positions[idx + 2], row, col };
}

/**
 * World position for an (oracle, strike), INTERPOLATED continuously along the
 * strike axis rather than snapped to the nearest grid column — as the trader
 * nudges the strike on the ticket the marker glides across the surface
 * (matching the chart's strike line) instead of jumping cell-to-cell.
 */
function locate(
  mesh: SurfaceMesh,
  surface: Surface,
  oracleId: string,
  strike: number,
): { x: number; y: number; z: number } | null {
  const row = surface.rows.findIndex((r) => r.oracleId === oracleId);
  if (row < 0) return null;
  const r = surface.rows[row];
  const k = Math.log(strike / r.forward);
  const grid = surface.kGrid; // ascending log-moneyness, one entry per column
  // Bracket k between columns c0..c1, then take the fraction t in between.
  let c1 = grid.findIndex((g) => g >= k);
  if (c1 < 0) c1 = grid.length - 1; // k past the last column → clamp to the edge
  const c0 = Math.max(0, c1 - 1);
  const span = grid[c1] - grid[c0];
  const t = span !== 0 ? Math.max(0, Math.min(1, (k - grid[c0]) / span)) : 0;
  const i0 = (row * mesh.cols + c0) * 3;
  const i1 = (row * mesh.cols + c1) * 3;
  const lerp = (a: number, b: number) => a + (b - a) * t;
  return {
    x: lerp(mesh.positions[i0], mesh.positions[i1]),
    y: lerp(mesh.positions[i0 + 1], mesh.positions[i1 + 1]),
    z: lerp(mesh.positions[i0 + 2], mesh.positions[i1 + 2]),
  };
}

const UP_ACCENT = '#4dd6b0';
const DOWN_ACCENT = '#f0796b';

/** The selected strike: white orb + pulsing accent ring + drop-line (legacy port). */
function SelectedMarker({
  mesh,
  surface,
  sel,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
  sel: Extract<SurfaceSelection, { kind: 'binary' }>;
}) {
  const ref = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const accent = sel.isUp ? UP_ACCENT : DOWN_ACCENT;
  const pos = useMemo(() => locate(mesh, surface, sel.oracleId, sel.strike), [mesh, surface, sel]);
  useFrame((state) => {
    if (reduced) return;
    const t = state.clock.elapsedTime;
    if (ref.current) ref.current.scale.setScalar(1 + 0.16 * Math.sin(t * 4));
    if (ringRef.current) {
      const s = 1 + 0.22 * Math.sin(t * 2.6);
      ringRef.current.scale.set(s, s, s);
      (ringRef.current.material as THREE.MeshBasicMaterial).opacity = 0.5 + 0.3 * Math.sin(t * 2.6);
    }
  });
  if (!pos) return null;
  return (
    <group>
      {/* Drop-line to the floor — anchors the selection in 3-D space. */}
      <mesh position={[pos.x, (pos.y + 0.12) / 2, pos.z]} raycast={() => null}>
        <cylinderGeometry args={[0.006, 0.006, Math.max(pos.y + 0.12, 0.01), 6]} />
        <meshBasicMaterial color={accent} transparent opacity={0.35} />
      </mesh>
      {/* Pulsing accent ring under the node. */}
      <mesh ref={ringRef} position={[pos.x, pos.y + 0.02, pos.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <ringGeometry args={[0.16, 0.21, 40]} />
        <meshBasicMaterial color={accent} transparent side={THREE.DoubleSide} />
      </mesh>
      {/* The node itself. */}
      <mesh ref={ref} position={[pos.x, pos.y + 0.12, pos.z]} raycast={() => null}>
        <sphereGeometry args={[0.1, 20, 20]} />
        <meshBasicMaterial color="#f4f6f8" />
      </mesh>
    </group>
  );
}

const PNL_UP = '#4dd6b0'; // winning — teal (matches --up)
const PNL_DOWN = '#f0796b'; // losing — coral (matches --down)
const PNL_FLAT = '#9aa3ad'; // break-even / unknown — neutral

/**
 * SurfacePositionPins — the trader's open bets rendered ON the surface at their
 * (market, strike). Colour = live PnL (winning teal / losing coral); a small
 * white chevron caps each pin to show the bet's DIRECTION (up/down), so the two
 * meanings the app packs into teal/coral never collide. Hover a pin for the full
 * read. This is the portfolio cockpit: watch your money ride the landscape.
 */
function SurfacePositionPins({
  mesh,
  surface,
  positions,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
  positions: V2PortfolioPosition[];
}) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  return (
    <group>
      {positions.map((p) => (
        <PositionPin key={p.key} mesh={mesh} surface={surface} p={p} reduced={reduced} />
      ))}
    </group>
  );
}

/** Time-to-expiry (ms) under which a pin starts ramping up its urgency and shows
 *  an always-on countdown. Most trading is on 1–5m markets, where a small calm
 *  gem goes unnoticed — so the closer to expiry, the louder the pin gets. */
const PIN_NEAR_MS = 10 * 60_000; // start reacting under 10 minutes
const PIN_PEAK_MS = 20_000; //     fully urgent at 20 seconds

/** Compact, glanceable countdown: `47s`, `4:03`, or `2h 10m` further out. */
function countdownLabel(ms: number): string {
  if (ms <= 0) return 'settling';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}:${String(rem).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function PositionPin({
  mesh,
  surface,
  p,
  reduced,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
  p: V2PortfolioPosition;
  reduced: boolean;
}) {
  const [hovered, setHovered] = useState(false);
  const now = useNow(0); // shared 1s clock — ticks the countdown + urgency ramp
  const gemMatRef = useRef<THREE.MeshStandardMaterial>(null);
  const gemMeshRef = useRef<THREE.Mesh>(null);
  const haloMatRef = useRef<THREE.MeshBasicMaterial>(null);
  const pos = useMemo(
    () => (p.marketId && p.strike != null ? locate(mesh, surface, p.marketId, p.strike) : null),
    [mesh, surface, p.marketId, p.strike],
  );
  const pnl = p.pnl ?? 0;
  const color = p.pnl == null ? PNL_FLAT : pnl >= 0 ? PNL_UP : PNL_DOWN;
  const up = p.direction === 'Up';

  // Urgency 0→1 as the market nears expiry — a 1–5m bet lives almost entirely in
  // this band, so it drives a bigger, faster-pulsing, glowing gem that a trader
  // watching the ticket can't miss. Bets far from expiry stay a calm dot.
  const ttlMs = p.expiry != null ? p.expiry - now : Number.POSITIVE_INFINITY;
  const urgency = Number.isFinite(ttlMs)
    ? Math.max(0, Math.min(1, (PIN_NEAR_MS - ttlMs) / (PIN_NEAR_MS - PIN_PEAK_MS)))
    : 0;
  const nearExpiry = ttlMs < PIN_NEAR_MS;

  // Live "breathe" whose depth, speed, size, and glow all scale with urgency
  // (mutated per frame — no re-render). `urgency` refreshes each 1s tick and
  // useFrame always runs the latest closure, so this stays current without a ref.
  // Reduced motion → no throb, steady glow.
  useFrame((state) => {
    const u = urgency;
    const t = state.clock.elapsedTime;
    const freq = 2.2 + u * 7; // heartbeat quickens as the deadline closes in
    const wave = reduced ? 0 : Math.sin(t * freq);
    const emissiveBase = (hovered ? 0.95 : 0.5) + u * 0.6;
    if (gemMatRef.current) gemMatRef.current.emissiveIntensity = emissiveBase + (0.12 + u * 0.5) * wave;
    const throb = 0.12 * u * wave;
    if (gemMeshRef.current) gemMeshRef.current.scale.setScalar(1 + u * 0.55 + throb);
    // Halo only blooms as the bet gets urgent — keeps the surface calm otherwise.
    if (haloMatRef.current) haloMatRef.current.opacity = (0.1 + u * 0.32) * (0.75 + 0.25 * (wave + 1) * 0.5);
  });

  if (!pos) return null;
  const gemY = pos.y + 0.3; // float the gem above the surface node

  return (
    <group>
      {/* Drop-stem anchoring the pin to its point on the surface. */}
      <mesh position={[pos.x, (pos.y + gemY) / 2, pos.z]} raycast={() => null}>
        <cylinderGeometry args={[0.004, 0.004, Math.max(gemY - pos.y, 0.01), 6]} />
        <meshBasicMaterial color={color} transparent opacity={0.4} />
      </mesh>
      {/* Base ring on the surface. */}
      <mesh position={[pos.x, pos.y + 0.015, pos.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <ringGeometry args={[0.05, 0.078, 28]} />
        <meshBasicMaterial color={color} transparent opacity={0.5} side={THREE.DoubleSide} />
      </mesh>
      {/* Glow halo — invisible at rest, blooms as expiry nears (opacity in frame). */}
      <mesh position={[pos.x, gemY, pos.z]} raycast={() => null} scale={2.4}>
        <sphereGeometry args={[0.078, 16, 16]} />
        <meshBasicMaterial
          ref={haloMatRef}
          color={color}
          transparent
          opacity={0}
          blending={THREE.AdditiveBlending}
          depthWrite={false}
        />
      </mesh>
      {/* The gem — the hoverable hit target; colour = PnL. Flip the cursor to a
          pointer (same convention as a tradeable surface node) so it reads as
          "hover me — there's more here". */}
      <mesh
        ref={gemMeshRef}
        position={[pos.x, gemY, pos.z]}
        onPointerOver={(e) => {
          e.stopPropagation();
          setHovered(true);
          if (typeof document !== 'undefined') document.body.style.cursor = 'pointer';
        }}
        onPointerOut={() => {
          setHovered(false);
          if (typeof document !== 'undefined') document.body.style.cursor = '';
        }}
      >
        <octahedronGeometry args={[0.078, 0]} />
        <meshStandardMaterial ref={gemMatRef} color={color} emissive={color} emissiveIntensity={0.5} roughness={0.3} metalness={0.1} />
      </mesh>
      {/* White direction chevron — apex up for UP bets, down for DOWN. */}
      <mesh position={[pos.x, gemY + 0.14, pos.z]} rotation={[0, 0, up ? 0 : Math.PI]} raycast={() => null}>
        <coneGeometry args={[0.05, 0.09, 4]} />
        <meshBasicMaterial color="#eef2f5" />
      </mesh>
      {/* Hover → full read; otherwise, a near-expiry bet keeps a live countdown
          on the surface so it registers even from a passing glance. */}
      {hovered ? (
        <Html position={[pos.x, gemY + 0.34, pos.z]} center occlude zIndexRange={[30, 0]}>
          <PositionPinLabel p={p} />
        </Html>
      ) : nearExpiry ? (
        <Html position={[pos.x, gemY + 0.26, pos.z]} center zIndexRange={[20, 0]}>
          <PinCountdownChip up={up} countdown={countdownLabel(ttlMs)} pnl={p.pnl ?? null} urgent={urgency > 0.6} />
        </Html>
      ) : null}
    </group>
  );
}

/** Always-on chip for a near-expiry bet — direction, live countdown, and live
 *  PnL right on the gem, so a fast-market trader reads "which way, how long, am I
 *  ahead" at a glance without hovering. A moving clock + colour-swinging PnL catch
 *  the eye far better than a static gem; hover still opens the full read (strike,
 *  leverage, delta). Brightens as the clock runs down. */
function PinCountdownChip({
  up,
  countdown,
  pnl,
  urgent,
}: {
  up: boolean;
  countdown: string;
  pnl: number | null;
  urgent: boolean;
}) {
  const dirColor = up ? UP_ACCENT : DOWN_ACCENT;
  const pnlColor = pnl == null ? 'var(--text-2)' : pnl >= 0 ? PNL_UP : PNL_DOWN;
  return (
    <div
      className={`glass pointer-events-none flex w-max -translate-y-1 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-[10px] tabular-nums shadow-[0_8px_20px_-10px_rgba(0,0,0,0.85)] ${
        urgent ? 'ring-1 ring-white/20' : ''
      }`}
    >
      <span style={{ color: dirColor }}>{up ? '▲' : '▼'}</span>
      <span className={urgent ? 'text-text-1' : 'text-text-2'}>{countdown}</span>
      <span className="text-text-3">·</span>
      <span style={{ color: pnlColor }}>{pnl == null ? '—' : signed(pnl, 2)}</span>
    </div>
  );
}

function PositionPinLabel({ p }: { p: V2PortfolioPosition }) {
  const up = p.direction === 'Up';
  const dirColor = up ? UP_ACCENT : DOWN_ACCENT;
  const pnl = p.pnl ?? 0;
  const pnlColor = p.pnl == null ? 'var(--text-2)' : pnl >= 0 ? PNL_UP : PNL_DOWN;
  return (
    <div className="glass pointer-events-none w-max -translate-y-1 rounded-lg px-2.5 py-1.5 text-center shadow-[0_10px_24px_-10px_rgba(0,0,0,0.85)]">
      <div className="flex items-center justify-center gap-1.5 whitespace-nowrap font-mono text-[10.5px] tabular-nums">
        <span style={{ color: dirColor }}>{up ? '▲ UP' : '▼ DOWN'}</span>
        <span className="text-text-3">·</span>
        <span className="text-text-1">{price(p.strike ?? 0, 0)}</span>
        {p.leverage != null && p.leverage > 1 && <span className="text-text-3">{p.leverage}×</span>}
      </div>
      <div className="mt-0.5 font-mono text-[11.5px] tabular-nums" style={{ color: pnlColor }}>
        {p.pnl == null ? '—' : `${signed(pnl, 2)} DUSDC`}
        {p.deltaPp != null && <span className="ml-1 text-[9px] text-text-3">({signed(p.deltaPp, 1)}pt)</span>}
      </div>
    </div>
  );
}

/**
 * BinaryWinZone — the side of the strike you win on lights up (legacy port):
 * a glowing ribbon sweeps along the winning half of the smile (fading toward
 * the edge), a subtle floor wash marks the price region, and an arrow points
 * the direction. UP → teal to higher prices (right); DOWN → coral to lower.
 */
function BinaryWinZone({
  mesh,
  surface,
  sel,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
  sel: Extract<SurfaceSelection, { kind: 'binary' }>;
}) {
  const accentHex = sel.isUp ? UP_ACCENT : DOWN_ACCENT;

  const geom = useMemo(() => {
    const cell = locateCell(mesh, surface, sel.oracleId, sel.strike);
    if (!cell) return null;
    // Win on the higher-price (right, larger col) side for UP, lower for DOWN.
    const edgeCol = sel.isUp ? mesh.cols - 1 : 0;
    const from = Math.min(cell.col, edgeCol);
    const to = Math.max(cell.col, edgeCol);
    const span = Math.max(to - from, 1);
    const accent = new THREE.Color(accentHex);
    const points: [number, number, number][] = [];
    const colors: [number, number, number][] = [];
    for (let c = from; c <= to; c++) {
      const idx = (cell.row * mesh.cols + c) * 3;
      points.push([mesh.positions[idx], mesh.positions[idx + 1] + 0.05, mesh.positions[idx + 2]]);
      // Bright at the strike, fading to dark at the winning edge.
      const dist = Math.abs(c - cell.col) / span;
      const col = accent.clone().multiplyScalar(1 - 0.9 * dist);
      colors.push([col.r, col.g, col.b]);
    }
    const edgeX = mesh.positions[(cell.row * mesh.cols + edgeCol) * 3];
    return { cell, points, colors, edgeX };
  }, [mesh, surface, sel, accentHex]);

  if (!geom || geom.points.length < 2) return null;

  const { cell, points, colors, edgeX } = geom;
  const dir = sel.isUp ? 1 : -1;

  return (
    <group>
      {/* subtle floor wash over the winning price region */}
      <mesh position={[(cell.x + edgeX) / 2, 0.012, cell.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <planeGeometry args={[Math.max(Math.abs(edgeX - cell.x), 0.01), 0.6]} />
        <meshBasicMaterial color={accentHex} transparent opacity={0.08} side={THREE.DoubleSide} />
      </mesh>

      {/* glow underlay + crisp ribbon sweeping the winning side of the smile,
          fading toward the edge (raycast off so it never steals node clicks) */}
      <Line points={points} vertexColors={colors} lineWidth={6} transparent opacity={0.3} raycast={() => null} />
      <Line points={points} vertexColors={colors} lineWidth={3} transparent opacity={0.95} raycast={() => null} />

      {/* direction arrow at the strike, pointing the way you win */}
      <mesh
        position={[cell.x + dir * 0.34, cell.y + 0.13, cell.z]}
        rotation={[0, 0, dir > 0 ? -Math.PI / 2 : Math.PI / 2]}
        raycast={() => null}
      >
        <coneGeometry args={[0.06, 0.16, 14]} />
        <meshBasicMaterial color={accentHex} />
      </mesh>
    </group>
  );
}

/** A single band edge: a faint drop-line to the floor + an accent orb. */
function EdgeOrb({ pos, orbRef }: { pos: { x: number; y: number; z: number }; orbRef?: React.Ref<THREE.Mesh> }) {
  return (
    <group>
      <mesh position={[pos.x, (pos.y + 0.12) / 2, pos.z]} raycast={() => null}>
        <cylinderGeometry args={[0.006, 0.006, Math.max(pos.y + 0.12, 0.01), 6]} />
        <meshBasicMaterial color={UP_ACCENT} transparent opacity={0.35} />
      </mesh>
      <mesh ref={orbRef} position={[pos.x, pos.y + 0.12, pos.z]} raycast={() => null}>
        <sphereGeometry args={[0.075, 18, 18]} />
        <meshBasicMaterial color={UP_ACCENT} />
      </mesh>
    </group>
  );
}

/**
 * RangeBandMarker — the vertical-range band on the surface (legacy port): an
 * accent orb at each strike, an overhead arc bridging them, and a shaded
 * "payout zone" on the floor. A range is one market = one expiry = one row.
 * (v2 bands always have both edges — no mid-pick anchor state like legacy.)
 */
function RangeBandMarker({
  mesh,
  surface,
  sel,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
  sel: Extract<SurfaceSelection, { kind: 'range' }>;
}) {
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const orbA = useRef<THREE.Mesh>(null);
  const orbB = useRef<THREE.Mesh>(null);

  const geom = useMemo(() => {
    const lo = locate(mesh, surface, sel.oracleId, sel.lower);
    const hi = locate(mesh, surface, sel.oracleId, sel.higher);
    if (!lo || !hi) return null;
    // An overhead arc bridging the two strike orbs — a quadratic bezier with a
    // lifted midpoint, so the band reads as a connected span even where the
    // smile is flat. Wider bands arch a little higher.
    const a = new THREE.Vector3(lo.x, lo.y + 0.12, lo.z);
    const b = new THREE.Vector3(hi.x, hi.y + 0.12, hi.z);
    const mid = a.clone().add(b).multiplyScalar(0.5);
    mid.y += Math.min(Math.max(a.distanceTo(b) * 0.5, 0.4), 1.2);
    const arc = new THREE.QuadraticBezierCurve3(a, mid, b)
      .getPoints(48)
      .map((p) => [p.x, p.y, p.z] as [number, number, number]);
    return { lo, hi, arc };
  }, [mesh, surface, sel]);

  useFrame((state) => {
    if (reduced) return;
    const s = 1 + 0.16 * Math.sin(state.clock.elapsedTime * 3.4);
    orbA.current?.scale.setScalar(s);
    orbB.current?.scale.setScalar(s);
  });

  if (!geom) return null;

  const { lo, hi, arc } = geom;
  const floorMidX = (lo.x + hi.x) / 2;
  const floorW = Math.max(Math.abs(hi.x - lo.x), 0.01);

  return (
    <group>
      {/* shaded payout zone on the floor — settlement lands here → the range wins */}
      <mesh position={[floorMidX, 0.012, lo.z]} rotation={[-Math.PI / 2, 0, 0]} raycast={() => null}>
        <planeGeometry args={[floorW, 0.5]} />
        <meshBasicMaterial color={UP_ACCENT} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>

      {/* soft glow underlay + crisp overhead arc bridging the two strike orbs.
          raycast disabled so it never steals clicks from nodes under the band. */}
      <Line points={arc} color={UP_ACCENT} lineWidth={7} transparent opacity={0.22} raycast={() => null} />
      <Line points={arc} color={UP_ACCENT} lineWidth={3} transparent opacity={0.95} raycast={() => null} />

      <EdgeOrb pos={lo} orbRef={orbA} />
      <EdgeOrb pos={hi} orbRef={orbB} />
    </group>
  );
}

/**
 * FillRipple — an expanding ring at the fill's node after a successful mint
 * (legacy port, fed by the v2 trade store's `pulseFill` — the popover and the
 * rail ticket both announce their mints there).
 */
function FillRipple({ mesh, surface }: { mesh: SurfaceMesh; surface: Surface }) {
  const fill = useV2TradeStore((s) => s.fill);
  const ref = useRef<THREE.Mesh>(null);
  const start = useRef(0);
  const pos = useMemo(
    () => (fill ? locate(mesh, surface, fill.marketId, fill.strike) : null),
    [mesh, surface, fill],
  );
  useEffect(() => {
    start.current = performance.now();
  }, [fill?.ts]);
  useFrame(() => {
    if (!ref.current) return;
    const t = Math.min((performance.now() - start.current) / 1100, 1);
    const s = 0.1 + t * 2.4;
    ref.current.scale.set(s, s, s);
    const mat = ref.current.material as THREE.MeshBasicMaterial;
    mat.opacity = (1 - t) * 0.8;
    ref.current.visible = t < 1;
  });
  if (!pos || !fill) return null;
  return (
    <mesh
      ref={ref}
      position={[pos.x, pos.y + 0.05, pos.z]}
      rotation={[-Math.PI / 2, 0, 0]}
      raycast={() => null}
    >
      <ringGeometry args={[0.25, 0.34, 32]} />
      <meshBasicMaterial color={fill.isUp ? UP_ACCENT : DOWN_ACCENT} transparent side={THREE.DoubleSide} />
    </mesh>
  );
}

/**
 * FirstRunPulse — a one-time coach mark for newcomers (legacy port): a teal orb
 * with an outward-rippling ring on the near-the-money node of the soonest
 * expiry, so "tap the surface to trade" is unmistakable. `show` is gated to
 * first-timers (and cleared on the first pick) by the parent; this just draws
 * the marker. Honors reduced-motion by holding the ripple static.
 */
function FirstRunPulse({
  mesh,
  surface,
  show,
  reduced,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
  show: boolean;
  reduced: boolean;
}) {
  const rippleRef = useRef<THREE.Mesh>(null);
  const orbRef = useRef<THREE.Mesh>(null);

  // The soonest-expiry row's at-the-money node (k≈0 → strike≈forward).
  const pos = useMemo(() => {
    if (!show) return null;
    let front: Surface['rows'][number] | null = null;
    for (const r of surface.rows) if (!front || r.expiry < front.expiry) front = r;
    return front ? locate(mesh, surface, front.oracleId, front.forward) : null;
  }, [mesh, surface, show]);

  useFrame((state) => {
    if (!pos) return;
    const t = state.clock.elapsedTime;
    if (rippleRef.current) {
      const phase = reduced ? 0.35 : (t % 1.6) / 1.6; // expanding 0→1 loop
      const s = 0.6 + phase * 1.9;
      rippleRef.current.scale.set(s, s, s);
      (rippleRef.current.material as THREE.MeshBasicMaterial).opacity = 0.55 * (1 - phase);
    }
    if (orbRef.current && !reduced) {
      orbRef.current.scale.setScalar(1 + 0.12 * Math.sin(t * 4));
    }
  });

  if (!pos) return null;
  return (
    <group>
      {/* Outward-rippling ring — the "tap here" pulse. */}
      <mesh
        ref={rippleRef}
        position={[pos.x, pos.y + 0.02, pos.z]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      >
        <ringGeometry args={[0.13, 0.2, 40]} />
        <meshBasicMaterial color={UP_ACCENT} transparent side={THREE.DoubleSide} />
      </mesh>
      {/* The node itself — a steady glowing orb to tap. */}
      <mesh ref={orbRef} position={[pos.x, pos.y + 0.12, pos.z]} raycast={() => null}>
        <sphereGeometry args={[0.085, 18, 18]} />
        <meshBasicMaterial color={UP_ACCENT} transparent opacity={0.9} />
      </mesh>
    </group>
  );
}

/** ms-epoch → compact "Jun 08" (UTC) for the expiry axis. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  return `${mon} ${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** In-canvas axis guide: strike ticks along the front edge, expiry labels down
 *  the right edge, and a faint forward meridian at k=0. Billboarded drei <Html>
 *  (constant pixel size) + one static <Line> — no per-frame cost. */
function SurfaceAxes({ mesh, now }: { mesh: SurfaceMesh; now: number }) {
  const isMobile = useMediaQuery('(max-width: 639px)');
  const maxExpiryLabels = isMobile ? 5 : 10;
  const labelStep = Math.max(1, Math.ceil(mesh.rowMeta.length / maxExpiryLabels));
  const lastRow = mesh.rowMeta.length - 1;

  const halfW = mesh.width / 2;
  const halfD = mesh.depth / 2;
  const y = -0.12;
  const frontZ = halfD;
  const rightX = halfW;

  const frontRow = mesh.rowMeta[mesh.rowMeta.length - 1];
  const n = mesh.colMeta.length;
  const tickIdx = [0, Math.round((n - 1) * 0.25), Math.round((n - 1) * 0.5), Math.round((n - 1) * 0.75), n - 1];

  const chip =
    'pointer-events-none select-none whitespace-nowrap rounded-[4px] bg-black/60 px-1.5 py-0.5 ring-1 ring-white/[0.06]';

  return (
    <group>
      <Line points={[[0, 0, -halfD], [0, 0, halfD]]} color="#aebccb" transparent opacity={0.34} lineWidth={2} />

      {tickIdx.map((c, i) => {
        const strike = frontRow.forward * Math.exp(mesh.colMeta[c].k);
        const isFwd = i === 2;
        return (
          <Html key={`s${c}`} position={[mesh.colMeta[c].x, y, frontZ + 0.4]} center occlude zIndexRange={[10, 0]}>
            <span className={`${chip} font-mono text-[10px] tabular-nums ${isFwd ? 'text-accent' : 'text-text-2'}`}>
              {price(strike, 0)}
              {isFwd ? ' · fwd' : ''}
            </span>
          </Html>
        );
      })}

      {mesh.rowMeta.map((rm, r) => {
        const keep = r % labelStep === 0 || r === lastRow;
        if (!keep || (r !== lastRow && lastRow - r < labelStep / 2)) return null;
        return (
          <Html key={`e${r}`} position={[rightX + 0.5, y, rm.z]} center occlude zIndexRange={[10, 0]}>
            <span className={`${chip} flex flex-col items-start gap-px font-mono text-[9px] tabular-nums leading-tight`}>
              <span className="text-text-1">{shortDate(rm.expiry)}</span>
              {/* Counted against the DISPLAYED moment — while rewound, "12m left"
                  must mean 12m left back then, not 12m from now. */}
              <span className="text-text-3">{ttl(rm.expiry, now)}</span>
            </span>
          </Html>
        );
      })}
    </group>
  );
}

function SurfaceTooltip({ hover }: { hover: HoverInfo }) {
  return (
    <div
      className="popover-in glass pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-[10px] px-3 py-2.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)]"
      style={{ left: hover.x, top: hover.y }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[14px] tabular-nums text-text-1">{price(hover.strike)}</span>
        <span className="font-mono text-[10px] tabular-nums text-text-3">IV {pct(hover.iv, 1)}</span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="flex items-center gap-1 rounded-md bg-(--accent-soft) px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-up">
          UP {pct(hover.up, 1)}
        </span>
        <span className="flex items-center gap-1 rounded-md bg-(--down-soft) px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-down">
          DN {pct(1 - hover.up, 1)}
        </span>
      </div>
      <div className="mt-2 font-mono text-[10px] tabular-nums text-text-3">
        {dateUTC(hover.expiry)} · {ttl(hover.expiry)}
      </div>
      {!hover.tradeable && (
        <div className="mt-2 border-t border-line-soft pt-2 font-mono text-[10px] leading-snug text-text-3">
          too far from spot to mint — pick a node nearer the colored ridge
        </div>
      )}
    </div>
  );
}

function SurfaceLegend({ ivMin, ivMax }: { ivMin: number; ivMax: number }) {
  const stops = useMemo(
    () =>
      Array.from({ length: 24 }, (_, i) => {
        const [r, g, b] = ivColor(1 - i / 23);
        return `rgb(${r * 255},${g * 255},${b * 255})`;
      }),
    [],
  );
  return (
    <div className="pointer-events-none absolute left-5 top-1/2 flex -translate-y-1/2 flex-col items-center gap-2">
      <span className="font-mono text-[10px] tabular-nums text-text-2">{pct(ivMax, 0)}</span>
      <div
        className="h-40 w-1.5 rounded-full ring-1 ring-inset ring-white/5"
        style={{ background: `linear-gradient(180deg, ${stops.join(',')})` }}
      />
      <span className="font-mono text-[10px] tabular-nums text-text-2">{pct(ivMin, 0)}</span>
      <span className="mt-1 [writing-mode:vertical-rl] rotate-180 text-[9px] uppercase tracking-[0.18em] text-text-3">
        Implied vol
      </span>
    </div>
  );
}

function SurfaceMeta({
  expiries,
  hasButterfly,
  hasCalendar,
  showNoArb,
}: {
  expiries: number;
  hasButterfly: boolean;
  hasCalendar: boolean;
  showNoArb: boolean;
}) {
  const arb = hasButterfly || hasCalendar;
  return (
    <div className="pointer-events-none absolute right-5 top-5 flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">BTC</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">SVI surface · live</span>
      </div>
      <span className="font-mono text-[10px] tabular-nums text-text-3">{expiries} expiries</span>
      {showNoArb && (
        <span
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
            arb ? 'bg-(--down-soft) text-down' : 'bg-(--accent-soft) text-accent'
          }`}
        >
          {arb ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-down" />
              {[hasButterfly && 'butterfly', hasCalendar && 'calendar'].filter(Boolean).join(' · ')} arb
            </>
          ) : (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-accent" />
              no-arb
            </>
          )}
        </span>
      )}
    </div>
  );
}

/**
 * Floating glass control bar — the legacy segmented overlay group (Arb Check /
 * Stress) without the LIVE/time-travel scrub (no per-market SVI history in the
 * v2 data path yet; the scrub joins this bar when it ships).
 */
/**
 * The surface's only chrome: a LIVE snap-pill + time-travel scrub on the left, the
 * overlay toggles on the right (legacy SurfaceControls parity).
 *
 * The scrub replays the RECORDED SVI tape (v2 exposes no server-side SVI history —
 * see lib/surface/v2-svi-tape.ts), so until ~30s of tape exists the slider is
 * disabled and says so honestly rather than pretending to have history.
 */
function SurfaceControls({
  isLive,
  currentTime,
  historyReady,
  showNoArb,
  onNoArb,
  stress,
  onStress,
}: {
  isLive: boolean;
  currentTime: number;
  historyReady: boolean;
  showNoArb: boolean;
  onNoArb: () => void;
  stress: boolean;
  onStress: (v: boolean) => void;
}) {
  const scrub = useV2SurfaceStore((s) => s.scrub);
  const setScrub = useV2SurfaceStore((s) => s.setScrub);
  const requestLive = useV2SurfaceStore((s) => s.requestLive);

  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 flex max-w-[calc(100%-1rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-xl p-1.5 shadow-[0_16px_44px_-12px_rgba(0,0,0,0.7)] glass sm:bottom-5 sm:flex-nowrap">
      {/* Returning to live is a glide, not a cut — requestLive aims the follower at
          the newest frame and the handoff commits once the surface arrives. */}
      <button
        onClick={requestLive}
        className={`flex h-8 shrink-0 items-center gap-2 rounded-lg px-3 text-[11px] font-medium uppercase tracking-wider transition-colors ${
          isLive ? 'bg-(--accent-soft) text-accent' : 'text-text-3 hover:bg-white/4 hover:text-text-2'
        }`}
      >
        Live
      </button>

      <div className="flex items-center gap-2 px-1 sm:gap-2.5 sm:px-2">
        <span className="flex shrink-0 items-center gap-1">
          <span className="hidden text-[10px] font-medium uppercase tracking-wider text-text-3 sm:inline">
            Time Travel
          </span>
          <InfoTip label="Time Travel" size={13}>
            <span className="block">
              <span className="font-medium text-accent">Time Travel</span> — drag the slider to rewind
              the volatility surface and watch how the odds shifted, moment by moment.{' '}
              <span className="font-medium text-text-1">Drag slowly</span> — the surface morphs as you
              go, and a gentle pace is what makes it read.
            </span>
            <span className="mt-2 block">
              Each keyframe is a real recording of the prices the protocol was quoting, captured
              live while this page is open — so the window grows the longer you watch (the motion
              between recordings is smoothed). The time on the right is the moment you’re viewing;
              hit <span className="font-medium text-accent">Live</span> to snap back to the
              streaming surface. Rewound odds aren’t for sale, so trading is paused until you do.
            </span>
          </InfoTip>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.001}
          value={scrub}
          disabled={!historyReady}
          onChange={(e) => setScrub(Number(e.target.value))}
          className="surface-scrub h-1 w-32 cursor-pointer disabled:cursor-not-allowed disabled:opacity-30 sm:w-52"
          aria-label="Time-travel scrub"
        />
        <span className="w-16 whitespace-nowrap text-center font-mono text-[10px] tabular-nums text-text-2 sm:w-20">
          {!historyReady ? 'recording…' : isLive ? 'now' : timeUTC(currentTime)}
        </span>
      </div>

      <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
        <div className="flex items-center gap-0.5 rounded-lg bg-bg-3 p-0.5">
          <SegToggle active={showNoArb} onClick={onNoArb} tone="accent">
            Arb Check
          </SegToggle>
          <SegToggle active={stress} onClick={() => onStress(!stress)} tone="down">
            Stress
          </SegToggle>
        </div>
        <InfoTip label="the surface overlays" size={13}>
          <span className="block">
            <span className="font-medium text-accent">Arb Check</span> — scans the surface for prices
            that don’t add up, like a cheaper bet paying out more than a pricier one. Turn it on and
            any bad spots light up; if every price is fair, nothing shows.
          </span>
          <span className="mt-2 block">
            <span className="font-medium text-down">Stress</span> — drops one made-up bad price into
            the live surface, so Arb Check has a real example to catch. The rest of the surface stays
            exactly as it is. Turn both on to watch it flag the spot, then off to go back to live
            prices.
          </span>
        </InfoTip>
      </div>
    </div>
  );
}

function SegToggle({
  active,
  onClick,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  tone: 'accent' | 'down';
  children: React.ReactNode;
}) {
  const activeCls =
    tone === 'down' ? 'bg-(--down-soft) text-down' : 'bg-(--accent-soft) text-accent';
  return (
    <button
      onClick={onClick}
      aria-pressed={active}
      className={`h-7 whitespace-nowrap rounded-md px-2.5 text-[11px] font-medium uppercase tracking-wider transition-colors ${
        active ? activeCls : 'text-text-3 hover:text-text-2'
      }`}
    >
      {children}
    </button>
  );
}

/** The surface's cool→warm implied-vol ramp, as a flat swatch for the legend so
 *  the "Color" key matches the colors actually painted on the mesh. */
const IV_RAMP = 'linear-gradient(110deg, #6aa6e6, #4dd6b0 38%, #d9a94e 72%, #f0796b)';

/** One legend row — an axis arrow (or the color swatch) + its plain meaning. */
function LegendRow({
  icon: Icon,
  gradient,
  label,
  desc,
}: {
  icon?: IconType;
  gradient?: boolean;
  label: string;
  desc: string;
}) {
  return (
    <div className="flex items-center gap-2.5">
      {gradient ? (
        <span aria-hidden className="h-5 w-5 flex-none rounded-md" style={{ background: IV_RAMP }} />
      ) : (
        <span className="flex h-5 w-5 flex-none items-center justify-center rounded-md border border-line bg-white/[0.04] text-text-2">
          {Icon && <Icon size={12} />}
        </span>
      )}
      <span className="text-[10.5px] leading-snug text-text-3">
        <span className="font-medium text-text-1">{label}</span> — {desc}
      </span>
    </div>
  );
}

/**
 * Plain-English "how to read the surface" guide (legacy parity) — orients a
 * non-quant in one read. COLLAPSIBLE, never dismissable: the header pill always
 * stays on the hero, so a confused user can reopen the full guide at any time.
 * The open/collapsed choice is remembered in localStorage; defaults to open on
 * desktop and collapsed on mobile (keeps the hero clear + the blur box off LCP on
 * phones). `suppressed` (trade popover open) hides it without unmounting, so the
 * collapse state survives and it reliably reappears on close.
 */
function SurfaceCaption({ suppressed = false }: { suppressed?: boolean }) {
  const isDesktop = useMediaQuery('(min-width: 640px)');
  const [pref, setPref] = useState<'open' | 'collapsed' | null>(() => {
    if (typeof window === 'undefined') return null;
    const v = localStorage.getItem('predict.surfaceGuide');
    return v === 'open' || v === 'collapsed' ? v : null;
  });
  if (suppressed) return null;

  // No explicit choice yet → open on desktop, collapsed on mobile.
  const expanded = pref ? pref === 'open' : isDesktop;
  function toggle() {
    const next = expanded ? 'collapsed' : 'open';
    setPref(next);
    localStorage.setItem('predict.surfaceGuide', next);
  }

  return (
    <div className="glass pointer-events-auto absolute left-1/2 top-14 z-10 flex max-w-[min(22rem,calc(100vw-1.5rem))] -translate-x-1/2 flex-col overflow-hidden rounded-xl sm:top-6">
      {/* Header IS the toggle — the whole pill expands/collapses the guide, so a
          confused user can always reopen it. No dismiss; it never disappears. */}
      <button
        type="button"
        onClick={toggle}
        aria-expanded={expanded}
        aria-label={expanded ? 'Collapse the guide' : 'How to read the surface — expand the guide'}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-white/[0.03] sm:px-3.5 sm:py-2.5"
      >
        <LuBoxes size={13} className="shrink-0 text-accent" />
        <span className="whitespace-nowrap text-[11px] font-medium text-text-1">
          How to read the surface
        </span>
        <svg
          width="11"
          height="11"
          viewBox="0 0 10 10"
          fill="none"
          aria-hidden
          className={`ml-auto shrink-0 text-text-3 transition-transform ${expanded ? 'rotate-180' : ''}`}
        >
          <path d="M2 3.5 5 6.5 8 3.5" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" />
        </svg>
      </button>

      {expanded && (
        <div className="scroll-quiet flex max-h-[calc(100dvh-12rem)] flex-col gap-2 overflow-y-auto overscroll-contain px-3 pb-3 sm:max-h-none sm:gap-2.5 sm:overflow-visible sm:px-3.5">
          <p className="hidden text-[11px] leading-relaxed text-text-2 sm:block">
            The 3-D shape is a live map of every bet you can make. Here&apos;s what each part means:
          </p>

          {/* Visual key — each axis/color tied to its plain meaning. The Color
              swatch reuses the real cool→warm ramp painted on the mesh. */}
          <div className="flex flex-col gap-1.5">
            <LegendRow icon={LuMoveHorizontal} label="Left → right" desc="the price you bet on" />
            <LegendRow icon={LuMoveDiagonal} label="Front → back" desc="time until it's decided" />
            <LegendRow icon={LuMoveVertical} label="Height" desc="how big a move the market expects" />
            <LegendRow gradient label="Color" desc="warmer means more uncertainty" />
          </div>

          {/* The "aha" — a slim accent-bar note (no boxed inset), so it stays short. */}
          <div className="flex gap-2">
            <span aria-hidden className="w-px shrink-0 self-stretch rounded bg-accent/45" />
            <p className="text-[10.5px] leading-relaxed text-text-3">
              The <span className="text-text-2">dip</span> is today&apos;s price; the{' '}
              <span className="text-text-2">wings</span> rising on either side mean the market is
              bracing for a swing.
            </p>
          </div>

          <div className="hairline-fade" />
          {/* Desktop interactions — the surface is view-only below lg. (v2 has no
              time-travel scrub yet, so no "drag to rewind".) */}
          <p className="hidden text-[10px] leading-relaxed text-text-3 sm:block">
            <span className="text-text-2">Hover</span> for odds ·{' '}
            <span className="text-text-2">click</span> to trade ·{' '}
            <span className="text-down">Stress</span> tests the checker.
          </p>
          {/* Mobile — the surface is for reading; trading is from the list below. */}
          <p className="text-[10px] leading-relaxed text-text-3 sm:hidden">
            <span className="text-text-2">Tap</span> a point to inspect its odds. Trade from the
            markets list below.
          </p>
        </div>
      )}
    </div>
  );
}

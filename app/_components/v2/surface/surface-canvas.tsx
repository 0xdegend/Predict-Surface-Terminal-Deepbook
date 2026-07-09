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
 *    mesh (plus the status pill), Stress perturbs the SVI so the checker
 *    visibly fires; the popover always prices off the UNSTRESSED live inputs.
 *  - Legacy extras: first-run coach pulse, mode-aware tap hint, and a fill
 *    ripple on every successful mint (popover or rail ticket).
 *
 * Not yet ported: LIVE/time-travel scrub (needs a per-market SVI history the v2
 * data path doesn't expose today).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Html, Line, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { buildSurface, stressSvi, type SmileInput, type Surface } from '@/lib/svi/surface';
import { buildSurfaceMesh, ivColor, type SurfaceMesh } from '@/lib/svi/mesh';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { useNow } from '@/lib/hooks/use-now';
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { price, pct, dateUTC, ttl } from '@/lib/format';
import { InfoTip } from '@/app/_components/ui/info-tip';
import { SurfaceTradePopoverV2 } from './surface-trade-popover';
import type { V2Market } from '@/lib/api/v2/types';

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
  const strikeOffset = useV2TradeStore((s) => s.strikeOffset);
  const rangeLowerOffset = useV2TradeStore((s) => s.rangeLowerOffset);
  const rangeHigherOffset = useV2TradeStore((s) => s.rangeHigherOffset);
  const rangeAnchorOffset = useV2TradeStore((s) => s.rangeAnchorOffset);
  const pickSeq = useV2TradeStore((s) => s.pickSeq);
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setStrikeOffset = useV2TradeStore((s) => s.setStrikeOffset);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const pickRangeOffset = useV2TradeStore((s) => s.pickRangeOffset);

  // Drop rows at/past expiry: their w is frozen while T clamps to ~0, so
  // IV = √(w/T) explodes and the height/colour normalization pancakes every
  // other row until the market poll prunes the dead market.
  const liveInputs = useMemo(
    () => inputs.filter((i) => i.oracle.expiry > nowMs + 5_000),
    [inputs, nowMs],
  );
  // Stress perturbs the SVI (adds slope/skew) so the no-arb checker visibly
  // fires — the credibility flex. DISPLAY-ONLY: the trade popover prices off
  // the unstressed `liveInputs`. Live data is normally clean.
  const shownInputs = useMemo(
    () => (stress ? liveInputs.map((i) => ({ ...i, svi: stressSvi(i.svi) })) : liveInputs),
    [liveInputs, stress],
  );
  // Finer k-grid (49 cols) over ±0.06 log-moneyness — half legacy's ±0.12
  // window, sized to v2's short tenors (≤8h): the tradeable band of even the
  // longest row only spans |k| ≲ 0.035, so at ±0.12 three quarters of every row
  // was dead zone (washed slate) and the surface read as two pale slabs. At
  // ±0.06 the glowing ridge fills the canvas the way legacy's does.
  const surface = useMemo(
    () => buildSurface(shownInputs, { nowMs, kMin: -0.06, kMax: 0.06, kSteps: 49 }),
    [shownInputs, nowMs],
  );
  const mesh = useMemo(() => buildSurfaceMesh(surface), [surface]);

  const selection = useMemo<SurfaceSelection | null>(() => {
    if (!marketId) return null;
    const market = markets.find((m) => m.expiry_market_id === marketId);
    const row = surface.rows.find((r) => r.oracleId === marketId);
    if (!market || !row) return null; // selected market isn't on the surface (no seed row)
    const admStep = toFloat(market.admission_tick_size) || 1;
    const atm = toFloat(snapStrikeToAdmission(fromFloat(row.forward), BigInt(market.admission_tick_size)));
    if (mode === 'range') {
      if (rangeLowerOffset == null || rangeHigherOffset == null) return null;
      return {
        kind: 'range',
        oracleId: marketId,
        lower: atm + rangeLowerOffset * admStep,
        higher: atm + rangeHigherOffset * admStep,
      };
    }
    return { kind: 'binary', oracleId: marketId, strike: atm + strikeOffset * admStep, isUp };
  }, [marketId, markets, surface, mode, isUp, strikeOffset, rangeLowerOffset, rangeHigherOffset]);

  const { hasButterfly, hasCalendar } = surface;
  const bandSet = rangeLowerOffset != null && rangeHigherOffset != null;

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

  function pick(row: number, col: number) {
    // Surface is view-only below lg — trade from the rail/list instead.
    if (isMobile) return;
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
      if (st.rangeAnchorOffset != null && st.marketId) {
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
      pickRangeOffset(Math.round((clickedPrice - atm) / step));
      // Open the card only once this click COMPLETES the band — keep the surface
      // clear for the second pick (legacy parity).
      const after = useV2TradeStore.getState();
      if (after.rangeLowerOffset != null && after.rangeHigherOffset != null) {
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
    setStrikeOffset(Math.round((clickedPrice - atm) / step));
    // A surface pick is a full side-&-level choice — advance the rail ticket to
    // its bet step (legacy parity).
    markPicked();
    setPopover(true);
    setClickId((n) => n + 1); // remount so glance/size reset on each new pick
  }

  // A surface needs ≥2 live expiries; between market rolls the filter can
  // briefly leave fewer — hold a quiet placeholder rather than a broken mesh.
  if (surface.rows.length < 2) {
    return (
      <div className="flex h-full w-full items-center justify-center">
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-text-3">
          waiting for live markets…
        </span>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [8, 7.5, 12.5], fov: 38 }}
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
          />
          <SurfaceAxes mesh={mesh} />
          {selection?.kind === 'binary' && (
            <>
              <BinaryWinZone mesh={mesh} surface={surface} sel={selection} />
              <SelectedMarker mesh={mesh} surface={surface} sel={selection} />
            </>
          )}
          {selection?.kind === 'range' && <RangeBandMarker mesh={mesh} surface={surface} sel={selection} />}
          <FillRipple mesh={mesh} surface={surface} />
          <FirstRunPulse
            mesh={mesh}
            surface={surface}
            reduced={reduced}
            show={!isMobile && !coachSeen && pickSeq === 0 && !popover}
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
          enableZoom
          autoRotate={!hover && !reduced && !popover && rangeAnchorOffset == null}
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
      {popover && !(mode === 'range' && !bandSet) && (
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
        showNoArb={showNoArb}
        onNoArb={() => setShowNoArb((v) => !v)}
        stress={stress}
        onStress={setStress}
      />

      {/* Tap-to-trade hint — desktop only (the surface is view-only below lg).
          Mode-aware, fading out once the relevant pick is made (legacy parity). */}
      <div
        className={`pointer-events-none absolute bottom-19 left-1/2 hidden -translate-x-1/2 transition-all duration-300 lg:block ${
          (mode === 'range' ? bandSet : pickSeq > 0) ? 'translate-y-1 opacity-0' : 'opacity-100'
        }`}
      >
        <span className="chip h-7 px-3 text-[11px] text-text-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          {mode === 'range'
            ? rangeAnchorOffset != null && !bandSet
              ? 'Tap the second price level to set your range'
              : 'Tap two price levels to set your range'
            : 'Tap a point on the surface to build a trade'}
        </span>
      </div>
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
}: {
  surface: Surface;
  mesh: SurfaceMesh;
  showNoArb: boolean;
  reduced: boolean;
  onHover: (h: HoverInfo | null) => void;
  onPick: (row: number, col: number) => void;
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
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    // Start flat (y=0) so the surface ASSEMBLES upward on first frames — the
    // load choreography (§10.6). Under reduced motion, start at full height.
    const init = mesh.positions.slice();
    if (!reduced) {
      for (let i = 1; i < init.length; i += 3) init[i] = 0;
    }
    g.setAttribute('position', new THREE.BufferAttribute(init, 3));
    g.setAttribute('color', new THREE.BufferAttribute(targetColors.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    return g;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topoKey]);

  useEffect(() => () => geom.dispose(), [geom]);

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
    const a = reduced ? 1 : 1 - Math.pow(0.0008, delta);
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
    // parity) — the cursor is the first "you can trade this" signal.
    if (typeof document !== 'undefined') {
      document.body.style.cursor = cell.tradeable ? 'pointer' : 'not-allowed';
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
function SurfaceAxes({ mesh }: { mesh: SurfaceMesh }) {
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
              <span className="text-text-3">{ttl(rm.expiry)}</span>
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
function SurfaceControls({
  showNoArb,
  onNoArb,
  stress,
  onStress,
}: {
  showNoArb: boolean;
  onNoArb: () => void;
  stress: boolean;
  onStress: (v: boolean) => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-xl p-1.5 shadow-[0_16px_44px_-12px_rgba(0,0,0,0.7)] glass sm:bottom-5">
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
          <span className="font-medium text-down">Stress</span> — bends the surface out of shape on
          purpose, so Arb Check has something to flag. Turn both on to watch it catch the problem,
          then off to go back to live prices.
        </span>
      </InfoTip>
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

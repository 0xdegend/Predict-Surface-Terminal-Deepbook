"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Canvas, useFrame, type ThreeEvent } from "@react-three/fiber";
import { OrbitControls, Grid, Html, Line } from "@react-three/drei";
import * as THREE from "three";
import { buildSurface, type SmileInput, type Surface } from "@/lib/svi/surface";
import { buildSurfaceMesh, ivColor, type SurfaceMesh } from "@/lib/svi/mesh";
import { snapStrikeToTick } from "@/lib/keys";
import { toFloat } from "@/config/scale";
import { pct, price, dateUTC, ttl } from "@/lib/format";
import { useSurfaceStore } from "@/lib/store/surface-store";
import { useMediaQuery } from "@/lib/hooks/use-media-query";
import { useSurfaceInputs } from "./use-surface-inputs";
import { SurfaceControls } from "./surface-controls";
import type { Oracle } from "@/lib/api/types";

/** Respect the OS reduced-motion setting (§10.6). */
const REDUCE_QUERY = "(prefers-reduced-motion: reduce)";
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(REDUCE_QUERY);
      mq.addEventListener("change", cb);
      return () => mq.removeEventListener("change", cb);
    },
    () => window.matchMedia(REDUCE_QUERY).matches,
    () => false, // SSR: assume motion allowed
  );
}

interface HoverInfo {
  row: number;
  col: number;
  x: number; // canvas-relative px
  y: number;
  strike: number;
  expiry: number;
  iv: number;
  up: number;
  tradeable: boolean;
}

/**
 * Live, morphing 3-D SVI surface (Phase 3) + click-to-trade (Phase 4).
 * Hover a node → tooltip; click → pre-fills the trade ticket via the store.
 * The mesh lerps toward each target every frame (the buttery morph). One Canvas.
 */
export function SurfaceCanvas({
  oracles,
  initialInputs,
}: {
  oracles: Oracle[];
  initialInputs: SmileInput[];
}) {
  const { inputs, isLive, currentTime, historyReady } = useSurfaceInputs(
    oracles,
    initialInputs,
  );
  const showNoArb = useSurfaceStore((s) => s.showNoArb);
  const select = useSurfaceStore((s) => s.select);
  const selection = useSurfaceStore((s) => s.selection);
  const reduced = usePrefersReducedMotion();

  const { surface, mesh } = useMemo(() => {
    const s = buildSurface(inputs, { kMin: -0.12, kMax: 0.12, kSteps: 49 });
    return { surface: s, mesh: buildSurfaceMesh(s) };
  }, [inputs]);

  const oracleById = useMemo(() => {
    const m = new Map<string, Oracle>();
    for (const i of inputs) m.set(i.oracle.oracle_id, i.oracle);
    return m;
  }, [inputs]);

  const [hover, setHover] = useState<HoverInfo | null>(null);

  function pick(row: number, col: number) {
    const r = surface.rows[row];
    const cell = r?.cells[col];
    const oracle = oracleById.get(r?.oracleId ?? "");
    if (!r || !cell || !oracle) return;
    // Dead-zone nodes (fair UP outside the 1%–99% band) are dimmed and not
    // mintable — ignore the click rather than load a doomed ticket.
    if (!cell.tradeable) return;
    const strikeFloat = r.forward * Math.exp(cell.k);
    const strikeScaled = snapStrikeToTick(
      BigInt(Math.round(strikeFloat * 1e9)),
      oracle,
    );
    select({
      oracleId: r.oracleId,
      expiry: r.expiry,
      strikeScaled: strikeScaled.toString(),
      strike: toFloat(Number(strikeScaled)),
      isUp: cell.k <= 0, // below forward → UP is the natural side; user can flip
    });
    // On stacked (mobile/tablet) layouts the ticket sits far below — bring it
    // into view. Desktop keeps it in the right rail, so don't scroll there.
    if (typeof window !== "undefined" && window.innerWidth < 1024) {
      document
        .getElementById("trade-ticket")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [8, 7.5, 12.5], fov: 38 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
      >
        <color attach="background" args={["#0A0B0D"]} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[6, 12, 8]} intensity={1.1} />
        <directionalLight
          position={[-8, 5, -6]}
          intensity={0.35}
          color="#6fb7ff"
        />

        <group position={[0, -1.4, 0]}>
          <MorphSurface
            mesh={mesh}
            surface={surface}
            showNoArb={showNoArb}
            reduced={reduced}
            onHover={setHover}
            onPick={pick}
          />
          <SelectedMarker mesh={mesh} surface={surface} />
          <BinaryWinZone mesh={mesh} surface={surface} />
          <RangeBandMarker mesh={mesh} surface={surface} />
          <FillRipple mesh={mesh} surface={surface} />
          <SurfaceAxes mesh={mesh} />
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
          minDistance={8}
          maxDistance={22}
          maxPolarAngle={Math.PI / 2.05}
          autoRotate={isLive && !hover && !reduced}
          autoRotateSpeed={0.1}
          target={[0, -0.5, 0]}
        />
      </Canvas>

      {hover && <SurfaceTooltip hover={hover} />}
      <SurfaceLegend ivMin={mesh.ivMin} ivMax={mesh.ivMax} />
      <SurfaceMeta
        expiries={surface.rows.length}
        underlying={surface.underlying}
        hasCalendar={surface.hasCalendar}
        hasButterfly={surface.hasButterfly}
        showNoArb={showNoArb}
      />
      <SurfaceControls
        isLive={isLive}
        currentTime={currentTime}
        historyReady={historyReady}
      />

      <SurfaceCaption />

      {/* Empty-state hint — fades out once a node is selected. */}
      <div
        className={`pointer-events-none absolute bottom-[5.25rem] left-1/2 -translate-x-1/2 transition-all duration-300 ${
          selection ? "translate-y-1 opacity-0" : "opacity-100"
        }`}
      >
        <span className="chip h-7 px-3 text-[11px] text-text-2">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" />
          Tap a point on the surface to build a trade
        </span>
      </div>
    </div>
  );
}

/** Map a world-space intersection to the nearest (row, col) grid node. */
function nearestCell(
  mesh: SurfaceMesh,
  point: THREE.Vector3,
): { row: number; col: number } {
  let col = 0;
  let best = Infinity;
  for (let c = 0; c < mesh.colMeta.length; c++) {
    const d = Math.abs(mesh.colMeta[c].x - point.x);
    if (d < best) {
      best = d;
      col = c;
    }
  }
  let row = 0;
  best = Infinity;
  for (let r = 0; r < mesh.rowMeta.length; r++) {
    const d = Math.abs(mesh.rowMeta[r].z - point.z);
    if (d < best) {
      best = d;
      row = r;
    }
  }
  return { row, col };
}

/** Persistent geometry that eases toward the target mesh each frame + raycast. */
function MorphSurface({
  mesh,
  surface,
  showNoArb,
  reduced,
  onHover,
  onPick,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
  showNoArb: boolean;
  reduced: boolean;
  onHover: (h: HoverInfo | null) => void;
  onPick: (row: number, col: number) => void;
}) {
  const matRef = useRef<THREE.MeshStandardMaterial>(null);
  const lastCell = useRef<{ row: number; col: number }>({ row: -1, col: -1 });

  const targetColors = useMemo(() => {
    const c = mesh.colors.slice();
    if (showNoArb) {
      for (const v of mesh.violations) {
        const idx = (v.row * mesh.cols + v.col) * 3;
        c[idx] = 0.95;
        c[idx + 1] = 0.22;
        c[idx + 2] = 0.19;
      }
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
    g.setAttribute("position", new THREE.BufferAttribute(init, 3));
    g.setAttribute("color", new THREE.BufferAttribute(targetColors.slice(), 3));
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
    const posAttr = geom.getAttribute("position") as THREE.BufferAttribute;
    const colAttr = geom.getAttribute("color") as THREE.BufferAttribute;
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
    if (matRef.current && !reduced) {
      matRef.current.emissiveIntensity =
        0.12 + 0.04 * Math.sin(state.clock.elapsedTime * 0.8);
    }
  });

  function handleMove(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation();
    const { row, col } = nearestCell(mesh, e.point);
    const r = surface.rows[row];
    const cell = r?.cells[col];
    if (!cell) return;
    if (lastCell.current.row !== row || lastCell.current.col !== col) {
      lastCell.current = { row, col };
    }
    if (typeof document !== "undefined") {
      document.body.style.cursor = cell.tradeable ? "pointer" : "not-allowed";
    }
    onHover({
      row,
      col,
      x: e.nativeEvent.offsetX,
      y: e.nativeEvent.offsetY,
      strike: r.forward * Math.exp(cell.k),
      expiry: r.expiry,
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
          if (typeof document !== "undefined") document.body.style.cursor = "";
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
          roughness={0.45}
          metalness={0.1}
          emissive={new THREE.Color("#0d2b33")}
          emissiveIntensity={0.12}
        />
      </mesh>
      <mesh geometry={geom} raycast={() => null}>
        <meshBasicMaterial
          wireframe
          transparent
          opacity={0.1}
          color="#ffffff"
        />
      </mesh>
    </group>
  );
}

/** Find the (row, col) and world position for a given oracle + strike. */
/** Map an (oracle, strike) to its nearest grid cell — world xyz + row/col so
 *  callers can sample neighbouring columns (the range ribbon needs the span). */
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
  return {
    x: mesh.positions[idx],
    y: mesh.positions[idx + 1],
    z: mesh.positions[idx + 2],
    row,
    col,
  };
}

function locate(
  mesh: SurfaceMesh,
  surface: Surface,
  oracleId: string,
  strike: number,
): { x: number; y: number; z: number } | null {
  const cell = locateCell(mesh, surface, oracleId, strike);
  return cell ? { x: cell.x, y: cell.y, z: cell.z } : null;
}

const RANGE_ACCENT = "#4dd6b0";

/** A single band edge: a faint drop-line to the floor + an accent orb. */
function EdgeOrb({
  pos,
  orbRef,
}: {
  pos: { x: number; y: number; z: number };
  orbRef?: React.Ref<THREE.Mesh>;
}) {
  return (
    <group>
      <mesh position={[pos.x, (pos.y + 0.12) / 2, pos.z]} raycast={() => null}>
        <cylinderGeometry args={[0.006, 0.006, Math.max(pos.y + 0.12, 0.01), 6]} />
        <meshBasicMaterial color={RANGE_ACCENT} transparent opacity={0.35} />
      </mesh>
      <mesh ref={orbRef} position={[pos.x, pos.y + 0.12, pos.z]} raycast={() => null}>
        <sphereGeometry args={[0.075, 18, 18]} />
        <meshBasicMaterial color={RANGE_ACCENT} />
      </mesh>
    </group>
  );
}

/**
 * RangeBandMarker — draws the vertical-range band on the surface: an accent orb
 * at each strike, a glowing ribbon hugging the smile between them (the exact
 * slice the range pays on), and a shaded "payout zone" on the floor. A range is
 * one oracle = one expiry = one row, so the ribbon traces that single smile.
 * Reads `rangeSelection` (finalized) + `rangeAnchor` (first edge, mid-pick).
 */
function RangeBandMarker({
  mesh,
  surface,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
}) {
  const band = useSurfaceStore((s) => s.rangeSelection);
  const anchor = useSurfaceStore((s) => s.rangeAnchor);
  const reduced = usePrefersReducedMotion();
  const orbA = useRef<THREE.Mesh>(null);
  const orbB = useRef<THREE.Mesh>(null);

  const geom = useMemo(() => {
    if (!band) return null;
    const lo = locateCell(mesh, surface, band.oracleId, band.lower);
    const hi = locateCell(mesh, surface, band.oracleId, band.higher);
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
  }, [mesh, surface, band]);

  // Mid-pick: only the first edge chosen so far.
  const anchorPos = useMemo(
    () => (anchor && !band ? locate(mesh, surface, anchor.oracleId, anchor.strike) : null),
    [mesh, surface, anchor, band],
  );

  useFrame((state) => {
    if (reduced) return;
    const s = 1 + 0.16 * Math.sin(state.clock.elapsedTime * 3.4);
    orbA.current?.scale.setScalar(s);
    orbB.current?.scale.setScalar(s);
  });

  if (anchorPos) return <EdgeOrb pos={anchorPos} orbRef={orbA} />;
  if (!geom) return null;

  const { lo, hi, arc } = geom;
  const floorMidX = (lo.x + hi.x) / 2;
  const floorW = Math.max(Math.abs(hi.x - lo.x), 0.01);

  return (
    <group>
      {/* shaded payout zone on the floor — settlement lands here → the range wins */}
      <mesh
        position={[floorMidX, 0.012, lo.z]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      >
        <planeGeometry args={[floorW, 0.5]} />
        <meshBasicMaterial color={RANGE_ACCENT} transparent opacity={0.12} side={THREE.DoubleSide} />
      </mesh>

      {/* soft glow underlay + crisp overhead arc bridging the two strike orbs.
          raycast disabled so it never steals clicks from nodes under the band. */}
      <Line points={arc} color={RANGE_ACCENT} lineWidth={7} transparent opacity={0.22} raycast={() => null} />
      <Line points={arc} color={RANGE_ACCENT} lineWidth={3} transparent opacity={0.95} raycast={() => null} />

      <EdgeOrb pos={lo} orbRef={orbA} />
      <EdgeOrb pos={hi} orbRef={orbB} />
    </group>
  );
}

function SelectedMarker({
  mesh,
  surface,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
}) {
  const selection = useSurfaceStore((s) => s.selection);
  const ref = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const lineRef = useRef<THREE.Mesh>(null);
  const isUp = selection?.isUp ?? true;
  const accent = isUp ? "#4dd6b0" : "#f0796b";
  const pos = useMemo(
    () =>
      selection
        ? locate(mesh, surface, selection.oracleId, selection.strike)
        : null,
    [mesh, surface, selection],
  );
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (ref.current) ref.current.scale.setScalar(1 + 0.16 * Math.sin(t * 4));
    if (ringRef.current) {
      const s = 1 + 0.22 * Math.sin(t * 2.6);
      ringRef.current.scale.set(s, s, s);
      (ringRef.current.material as THREE.MeshBasicMaterial).opacity =
        0.5 + 0.3 * Math.sin(t * 2.6);
    }
  });
  if (!pos) return null;
  return (
    <group>
      {/* Drop-line to the floor — anchors the selection in 3-D space. */}
      <mesh
        ref={lineRef}
        position={[pos.x, (pos.y + 0.12) / 2, pos.z]}
        raycast={() => null}
      >
        <cylinderGeometry
          args={[0.006, 0.006, Math.max(pos.y + 0.12, 0.01), 6]}
        />
        <meshBasicMaterial color={accent} transparent opacity={0.35} />
      </mesh>
      {/* Pulsing accent ring under the node. */}
      <mesh
        ref={ringRef}
        position={[pos.x, pos.y + 0.02, pos.z]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      >
        <ringGeometry args={[0.16, 0.21, 40]} />
        <meshBasicMaterial color={accent} transparent side={THREE.DoubleSide} />
      </mesh>
      {/* The node itself. */}
      <mesh
        ref={ref}
        position={[pos.x, pos.y + 0.12, pos.z]}
        raycast={() => null}
      >
        <sphereGeometry args={[0.1, 20, 20]} />
        <meshBasicMaterial color="#f4f6f8" />
      </mesh>
    </group>
  );
}

/**
 * BinaryWinZone — visualizes an UP/DOWN binary on the surface: the side of the
 * strike you win on lights up. A glowing ribbon sweeps along the winning half of
 * the smile (fading toward the edge), a subtle floor wash marks the price region,
 * and an arrow points the direction. UP → teal sweeping to higher prices (right);
 * DOWN → coral to lower prices (left). Toggling UP/DOWN swings it to the other
 * side — the whole point. Hidden in range mode (the arc owns that).
 */
function BinaryWinZone({
  mesh,
  surface,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
}) {
  const selection = useSurfaceStore((s) => s.selection);
  const ticketMode = useSurfaceStore((s) => s.ticketMode);
  const up = selection?.isUp ?? true;
  const accentHex = up ? "#4dd6b0" : "#f0796b";

  const geom = useMemo(() => {
    if (!selection) return null;
    const cell = locateCell(mesh, surface, selection.oracleId, selection.strike);
    if (!cell) return null;
    // Win on the higher-price (right, larger col) side for UP, lower for DOWN.
    const edgeCol = up ? mesh.cols - 1 : 0;
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
  }, [mesh, surface, selection, up, accentHex]);

  if (ticketMode === "range") return null;
  if (!geom || geom.points.length < 2) return null;

  const { cell, points, colors, edgeX } = geom;
  const dir = up ? 1 : -1;

  return (
    <group>
      {/* subtle floor wash over the winning price region */}
      <mesh
        position={[(cell.x + edgeX) / 2, 0.012, cell.z]}
        rotation={[-Math.PI / 2, 0, 0]}
        raycast={() => null}
      >
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

function FillRipple({
  mesh,
  surface,
}: {
  mesh: SurfaceMesh;
  surface: Surface;
}) {
  const fill = useSurfaceStore((s) => s.fill);
  const ref = useRef<THREE.Mesh>(null);
  const start = useRef(0);
  const pos = useMemo(
    () => (fill ? locate(mesh, surface, fill.oracleId, fill.strike) : null),
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
      <meshBasicMaterial
        color={fill.isUp ? "#4dd6b0" : "#f0796b"}
        transparent
        side={THREE.DoubleSide}
      />
    </mesh>
  );
}

function SurfaceTooltip({ hover }: { hover: HoverInfo }) {
  return (
    <div
      className="popover-in glass pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-[calc(100%+14px)] rounded-[10px] px-3 py-2.5 shadow-[0_12px_32px_-8px_rgba(0,0,0,0.7)]"
      style={{ left: hover.x, top: hover.y }}
    >
      <div className="flex items-baseline justify-between gap-4">
        <span className="font-mono text-[14px] tabular-nums text-text-1">
          {price(hover.strike)}
        </span>
        <span className="font-mono text-[10px] tabular-nums text-text-3">
          IV {pct(hover.iv, 1)}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1.5">
        <span className="flex items-center gap-1 rounded-md bg-[var(--accent-soft)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-up">
          UP {pct(hover.up, 1)}
        </span>
        <span className="flex items-center gap-1 rounded-md bg-[var(--down-soft)] px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-down">
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
  // Top of the rail = high IV (warm), bottom = low IV (cool).
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
      <span className="font-mono text-[10px] tabular-nums text-text-2">
        {pct(ivMax, 0)}
      </span>
      <div
        className="h-40 w-1.5 rounded-full ring-1 ring-inset ring-white/5"
        style={{ background: `linear-gradient(180deg, ${stops.join(",")})` }}
      />
      <span className="font-mono text-[10px] tabular-nums text-text-2">
        {pct(ivMin, 0)}
      </span>
      <span className="mt-1 [writing-mode:vertical-rl] rotate-180 text-[9px] uppercase tracking-[0.18em] text-text-3">
        Implied vol
      </span>
    </div>
  );
}

function SurfaceMeta({
  expiries,
  underlying,
  hasCalendar,
  hasButterfly,
  showNoArb,
}: {
  expiries: number;
  underlying: string;
  hasCalendar: boolean;
  hasButterfly: boolean;
  showNoArb: boolean;
}) {
  const arb = hasCalendar || hasButterfly;
  return (
    <div className="pointer-events-none absolute right-5 top-5 flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">
          {underlying}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">
          SVI surface
        </span>
      </div>
      <span className="font-mono text-[10px] tabular-nums text-text-3">
        {expiries} expiries
      </span>
      {showNoArb && (
        <span
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
            arb
              ? "bg-[var(--down-soft)] text-down"
              : "bg-[var(--accent-soft)] text-accent"
          }`}
        >
          {arb ? (
            <>
              <span className="h-1.5 w-1.5 rounded-full bg-down" />
              {[hasButterfly && "butterfly", hasCalendar && "calendar"]
                .filter(Boolean)
                .join(" · ")}{" "}
              arb
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

/** ms-epoch → compact "Jun 08" (UTC) for the expiry axis. */
function shortDate(ms: number): string {
  const d = new Date(ms);
  const mon = d.toLocaleString("en-US", { month: "short", timeZone: "UTC" });
  return `${mon} ${String(d.getUTCDate()).padStart(2, "0")}`;
}

/**
 * In-canvas axis guide (legibility pass): strike ticks along the front edge,
 * expiry dates down the right edge, a faint "forward" meridian at k=0, and two
 * axis titles. All labels are billboarded drei <Html> (constant pixel size,
 * always face the camera) and the meridian is one static <Line> — no per-frame
 * cost, so the 60fps morph budget is untouched. k=0 maps to x=0 for every
 * expiry, so the forward is a single straight line down the centre.
 */
function SurfaceAxes({ mesh }: { mesh: SurfaceMesh }) {
  // The depth axis compresses on a small canvas, so all-expiries-at-once stack
  // on top of each other (esp. on a phone). Thin the labels to an evenly-spaced
  // subset — fewer on mobile — always keeping the first and last so both ends of
  // the expiry range stay anchored. The mesh + strike ticks are untouched.
  const isMobile = useMediaQuery("(max-width: 639px)");
  const maxExpiryLabels = isMobile ? 5 : 10;
  const labelStep = Math.max(1, Math.ceil(mesh.rowMeta.length / maxExpiryLabels));
  const lastRow = mesh.rowMeta.length - 1;

  const halfW = mesh.width / 2;
  const halfD = mesh.depth / 2;
  const y = -0.12; // sit labels just under the surface base, on the floor
  const frontZ = halfD; // +z edge faces the camera
  const rightX = halfW; // +x edge faces the camera

  // The front row (nearest the camera) anchors the strike price scale.
  const frontRow = mesh.rowMeta[mesh.rowMeta.length - 1];
  const n = mesh.colMeta.length;
  const tickIdx = [
    0,
    Math.round((n - 1) * 0.25),
    Math.round((n - 1) * 0.5),
    Math.round((n - 1) * 0.75),
    n - 1,
  ];

  // A dark backing chip keeps every label legible over BOTH the empty dark
  // background AND the bright surface it overlaps (over dark it's near-invisible,
  // over the glowing mesh it provides contrast — adaptive, like axis labels in
  // pro charting tools). Fonts stay small on purpose: the expiry labels multiply
  // as oracles grow, so they must not crowd the depth axis.
  const chip =
    "pointer-events-none select-none whitespace-nowrap rounded-[4px] bg-black/60 px-1.5 py-0.5 ring-1 ring-white/[0.06]";

  return (
    <group>
      {/* Forward meridian — the "you are here / 50-50" reference. */}
      <Line
        points={[
          [0, 0, -halfD],
          [0, 0, halfD],
        ]}
        color="#aebccb"
        transparent
        opacity={0.34}
        lineWidth={2}
      />

      {/* Strike ticks along the front edge; the centre tick is the forward. */}
      {tickIdx.map((c, i) => {
        const strike = frontRow.forward * Math.exp(mesh.colMeta[c].k);
        const isFwd = i === 2;
        return (
          <Html
            key={`s${c}`}
            position={[mesh.colMeta[c].x, y, frontZ + 0.4]}
            center
            occlude
          >
            <span
              className={`${chip} font-mono text-[10px] tabular-nums ${isFwd ? "text-accent" : "text-text-2"}`}
            >
              {price(strike, 0)}
              {isFwd ? " · fwd" : ""}
            </span>
          </Html>
        );
      })}

      {/* Expiry labels down the right edge (kept compact for many oracles). The
          tick values themselves identify each axis, so no separate axis titles
          are drawn — they used to collide with the control bar / hints. */}
      {mesh.rowMeta.map((rm, r) => {
        // Keep evenly-spaced labels plus the two endpoints; drop the rest so the
        // axis never crowds. (Skip a near-last tick that would touch the pinned
        // last one.)
        const keep = r % labelStep === 0 || r === lastRow;
        if (!keep || (r !== lastRow && lastRow - r < labelStep / 2)) return null;
        return (
          <Html key={`e${r}`} position={[rightX + 0.5, y, rm.z]} center occlude>
            <span
              className={`${chip} flex flex-col items-start gap-px font-mono text-[9px] tabular-nums leading-tight`}
            >
              <span className="text-text-1">{shortDate(rm.expiry)}</span>
              <span className="text-text-3">{ttl(rm.expiry)}</span>
            </span>
          </Html>
        );
      })}
    </group>
  );
}

/**
 * Dismissible plain-English explainer (legibility pass) — orients a non-quant
 * judge in one read. Persists dismissal in localStorage so it never re-nags.
 */
function SurfaceCaption() {
  // Read the dismissal lazily — this canvas is dynamically imported with
  // ssr:false, so `window`/`localStorage` exist at init and we avoid a
  // setState-in-effect (which triggers cascading renders).
  const [show, setShow] = useState(
    () =>
      typeof window === "undefined" ||
      localStorage.getItem("predict.surfaceCaption") !== "dismissed",
  );
  if (!show) return null;
  return (
    <div className="glass pointer-events-auto absolute left-1/2 top-14 z-10 flex max-w-60 -translate-x-1/2 items-start gap-2 rounded-xl px-3 py-2 sm:top-6 sm:max-w-sm sm:gap-2.5 sm:px-3.5 sm:py-2.5">
      <div className="flex flex-col gap-1 sm:gap-1.5">
        <p className="text-[10.5px] leading-snug text-text-2 sm:text-[11px] sm:leading-relaxed">
          <span className="font-medium text-text-1">
            Reading the surface —{" "}
          </span>
          height is how big a move the market is pricing in. The dip is
          today&apos;s price; the wings lifting on either side mean it&apos;s
          bracing for a swing. Warmer colors = more uncertainty.
        </p>
        <p className="text-[10px] leading-snug text-text-3 sm:leading-relaxed">
          Drag the slider to rewind · tap{" "}
          <span className="text-down">Stress</span> to fire the no-arb check.
        </p>
      </div>
      <button
        onClick={() => {
          localStorage.setItem("predict.surfaceCaption", "dismissed");
          setShow(false);
        }}
        aria-label="Dismiss explainer"
        className="-mr-1 -mt-0.5 shrink-0 rounded p-1 text-text-3 transition-colors hover:text-text-2"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
          <path
            d="M2 2 8 8M8 2 2 8"
            stroke="currentColor"
            strokeWidth="1.25"
            strokeLinecap="round"
          />
        </svg>
      </button>
    </div>
  );
}

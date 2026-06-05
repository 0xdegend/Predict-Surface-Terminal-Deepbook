'use client';

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { buildSurface, type SmileInput, type Surface } from '@/lib/svi/surface';
import { buildSurfaceMesh, ivColor, type SurfaceMesh } from '@/lib/svi/mesh';
import { snapStrikeToTick } from '@/lib/keys';
import { toFloat } from '@/config/scale';
import { pct, price, dateUTC, ttl } from '@/lib/format';
import { useSurfaceStore } from '@/lib/store/surface-store';
import { useSurfaceInputs } from './use-surface-inputs';
import { SurfaceControls } from './surface-controls';
import type { Oracle } from '@/lib/api/types';

/** Respect the OS reduced-motion setting (§10.6). */
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (cb) => {
      const mq = window.matchMedia(REDUCE_QUERY);
      mq.addEventListener('change', cb);
      return () => mq.removeEventListener('change', cb);
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
  const { inputs, isLive, currentTime, historyReady } = useSurfaceInputs(oracles, initialInputs);
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
    const oracle = oracleById.get(r?.oracleId ?? '');
    if (!r || !cell || !oracle) return;
    // Dead-zone nodes (fair UP outside the 1%–99% band) are dimmed and not
    // mintable — ignore the click rather than load a doomed ticket.
    if (!cell.tradeable) return;
    const strikeFloat = r.forward * Math.exp(cell.k);
    const strikeScaled = snapStrikeToTick(BigInt(Math.round(strikeFloat * 1e9)), oracle);
    select({
      oracleId: r.oracleId,
      expiry: r.expiry,
      strikeScaled: strikeScaled.toString(),
      strike: toFloat(Number(strikeScaled)),
      isUp: cell.k <= 0, // below forward → UP is the natural side; user can flip
    });
    // On stacked (mobile/tablet) layouts the ticket sits far below — bring it
    // into view. Desktop keeps it in the right rail, so don't scroll there.
    if (typeof window !== 'undefined' && window.innerWidth < 1024) {
      document.getElementById('trade-ticket')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  return (
    <div className="relative h-full w-full">
      <Canvas camera={{ position: [9, 7, 11], fov: 38 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
        <color attach="background" args={['#0A0B0D']} />
        <ambientLight intensity={0.6} />
        <directionalLight position={[6, 12, 8]} intensity={1.1} />
        <directionalLight position={[-8, 5, -6]} intensity={0.35} color="#6fb7ff" />

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
          <FillRipple mesh={mesh} surface={surface} />
          <Grid
            args={[mesh.width + 2, mesh.depth + 2]}
            cellSize={0.5}
            cellThickness={0.5}
            cellColor="#1a1d21"
            sectionSize={2}
            sectionThickness={0.8}
            sectionColor="#23272c"
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
          autoRotateSpeed={0.35}
          target={[0, -0.2, 0]}
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
      <SurfaceControls isLive={isLive} currentTime={currentTime} historyReady={historyReady} />

      {/* Empty-state hint — fades out once a node is selected. */}
      <div
        className={`pointer-events-none absolute bottom-[5.25rem] left-1/2 -translate-x-1/2 transition-all duration-300 ${
          selection ? 'translate-y-1 opacity-0' : 'opacity-100'
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
function nearestCell(mesh: SurfaceMesh, point: THREE.Vector3): { row: number; col: number } {
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
    if (matRef.current && !reduced) {
      matRef.current.emissiveIntensity = 0.12 + 0.04 * Math.sin(state.clock.elapsedTime * 0.8);
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
    if (typeof document !== 'undefined') {
      document.body.style.cursor = cell.tradeable ? 'pointer' : 'not-allowed';
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
          roughness={0.45}
          metalness={0.1}
          emissive={new THREE.Color('#0d2b33')}
          emissiveIntensity={0.12}
        />
      </mesh>
      <mesh geometry={geom} raycast={() => null}>
        <meshBasicMaterial wireframe transparent opacity={0.06} color="#ffffff" />
      </mesh>
    </group>
  );
}

/** Find the (row, col) and world position for a given oracle + strike. */
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
  return { x: mesh.positions[idx], y: mesh.positions[idx + 1], z: mesh.positions[idx + 2] };
}

function SelectedMarker({ mesh, surface }: { mesh: SurfaceMesh; surface: Surface }) {
  const selection = useSurfaceStore((s) => s.selection);
  const ref = useRef<THREE.Mesh>(null);
  const ringRef = useRef<THREE.Mesh>(null);
  const lineRef = useRef<THREE.Mesh>(null);
  const isUp = selection?.isUp ?? true;
  const accent = isUp ? '#4dd6b0' : '#f0796b';
  const pos = useMemo(
    () => (selection ? locate(mesh, surface, selection.oracleId, selection.strike) : null),
    [mesh, surface, selection],
  );
  useFrame((state) => {
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
      <mesh ref={lineRef} position={[pos.x, (pos.y + 0.12) / 2, pos.z]} raycast={() => null}>
        <cylinderGeometry args={[0.006, 0.006, Math.max(pos.y + 0.12, 0.01), 6]} />
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
      <mesh ref={ref} position={[pos.x, pos.y + 0.12, pos.z]} raycast={() => null}>
        <sphereGeometry args={[0.1, 20, 20]} />
        <meshBasicMaterial color="#f4f6f8" />
      </mesh>
    </group>
  );
}

function FillRipple({ mesh, surface }: { mesh: SurfaceMesh; surface: Surface }) {
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
      <meshBasicMaterial color={fill.isUp ? '#4dd6b0' : '#f0796b'} transparent side={THREE.DoubleSide} />
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
        <span className="font-mono text-[14px] tabular-nums text-text-1">{price(hover.strike)}</span>
        <span className="font-mono text-[10px] tabular-nums text-text-3">IV {pct(hover.iv, 1)}</span>
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
      <span className="font-mono text-[10px] tabular-nums text-text-3">{expiries} expiries</span>
      {showNoArb && (
        <span
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
            arb ? 'bg-[var(--down-soft)] text-down' : 'bg-[var(--accent-soft)] text-accent'
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

'use client';

/**
 * SurfaceCanvasV2 — the live SVI vol surface for the new deployment, now a
 * readable instrument rather than a bare mesh: hover tooltip (strike / IV /
 * UP-DOWN / expiry), IV colour legend, meta chip with the live no-arb status,
 * in-canvas axis guide (strike ticks, expiry labels, forward meridian), and a
 * Stress toggle that perturbs the SVI to make the arb checker visibly fire.
 *
 * Reuses the proven pure math (buildSurface + buildSurfaceMesh + ivColor) and is
 * v2-wired (no legacy surface-store): clicking selects a market + strike into
 * the v2 trade store (the rail ticket + smile handle the trade — no in-canvas
 * popover by design). X = log-moneyness, Z = expiry depth, Y/colour = IV.
 *
 * Not yet ported: LIVE/time-travel scrub (needs a per-market SVI history the v2
 * data path doesn't expose today).
 */
import { useMemo, useRef, useState } from 'react';
import { Canvas, useFrame, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls, Html, Line, Grid } from '@react-three/drei';
import * as THREE from 'three';
import { LuActivity } from 'react-icons/lu';
import { buildSurface, stressSvi, type SmileInput, type Surface } from '@/lib/svi/surface';
import { buildSurfaceMesh, ivColor, type SurfaceMesh } from '@/lib/svi/mesh';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { useMediaQuery } from '@/lib/hooks/use-media-query';
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import { price, pct, dateUTC, ttl } from '@/lib/format';
import { InfoTip } from '@/app/_components/ui/info-tip';
import type { V2Market } from '@/lib/api/v2/types';

interface HoverInfo {
  x: number; // canvas-relative px
  y: number;
  strike: number;
  expiry: number;
  iv: number;
  up: number;
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
  const [hover, setHover] = useState<HoverInfo | null>(null);

  // Stress perturbs the SVI (adds slope/skew) so the no-arb checker visibly
  // fires — the credibility flex. Live data is normally clean.
  const shownInputs = useMemo(
    () => (stress ? inputs.map((i) => ({ ...i, svi: stressSvi(i.svi) })) : inputs),
    [inputs, stress],
  );
  // Finer k-grid (49 cols) + the legacy ±0.12 window → a smoother, legible ridge.
  const surface = useMemo(
    () => buildSurface(shownInputs, { nowMs: serverNow, kMin: -0.12, kMax: 0.12, kSteps: 49 }),
    [shownInputs, serverNow],
  );
  const mesh = useMemo(() => buildSurfaceMesh(surface), [surface]);

  const hasButterfly = surface.rows.some((r) => r.cells.some((c) => c.butterfly));
  const hasCalendar = surface.rows.some((r) => r.cells.some((c) => c.calendar));

  return (
    <div className="relative h-full w-full">
      <Canvas
        camera={{ position: [8, 7.5, 12.5], fov: 38 }}
        dpr={[1, 2]}
        gl={{ antialias: true, alpha: true }}
        className="cursor-grab active:cursor-grabbing"
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
          <SurfaceMesh surface={surface} mesh={mesh} markets={markets} onHover={setHover} />
          <SurfaceAxes mesh={mesh} />
          {(hasButterfly || hasCalendar) && <ArbMarkers surface={surface} mesh={mesh} />}
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
          autoRotate={!hover}
          autoRotateSpeed={0.1}
          minDistance={8}
          maxDistance={22}
          maxPolarAngle={Math.PI / 2.05}
          target={[0, -0.5, 0]}
        />
      </Canvas>

      {hover && <SurfaceTooltip hover={hover} />}
      <SurfaceLegend ivMin={mesh.ivMin} ivMax={mesh.ivMax} />
      <SurfaceMeta expiries={surface.rows.length} hasButterfly={hasButterfly} hasCalendar={hasCalendar} />
      <SurfaceControls stress={stress} onStress={setStress} />
    </div>
  );
}

function SurfaceMesh({
  surface,
  mesh,
  markets,
  onHover,
}: {
  surface: Surface;
  mesh: SurfaceMesh;
  markets: V2Market[];
  onHover: (h: HoverInfo | null) => void;
}) {
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setStrikeOffset = useV2TradeStore((s) => s.setStrikeOffset);
  const markPicked = useV2TradeStore((s) => s.markPicked);
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  const matRef = useRef<THREE.MeshStandardMaterial>(null);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    return g;
  }, [mesh]);

  // The surface is the only element that glows (design brief) — a slow emissive
  // breath, off under prefers-reduced-motion.
  useFrame((state) => {
    if (!reduced && matRef.current) {
      matRef.current.emissiveIntensity = 0.18 + 0.05 * Math.sin(state.clock.elapsedTime * 0.8);
    }
  });

  function cellAt(e: ThreeEvent<PointerEvent | MouseEvent>) {
    const { row, col } = nearestCell(mesh, e.point);
    const sRow = surface.rows[row];
    const cell = sRow?.cells[col];
    if (!sRow || !cell) return null;
    return { sRow, cell, strike: sRow.forward * Math.exp(cell.k) };
  }

  function handleMove(e: ThreeEvent<PointerEvent>) {
    e.stopPropagation();
    const c = cellAt(e);
    if (!c) return;
    onHover({
      x: e.nativeEvent.offsetX,
      y: e.nativeEvent.offsetY,
      strike: c.strike,
      expiry: c.sRow.expiry,
      iv: c.cell.iv,
      up: c.cell.up,
    });
  }

  function pick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    const c = cellAt(e);
    if (!c) return;
    const market = markets.find((m) => m.expiry_market_id === c.sRow.oracleId);
    if (!market) return;
    const step = toFloat(market.admission_tick_size) || 1;
    const atm = toFloat(snapStrikeToAdmission(fromFloat(c.sRow.forward), BigInt(market.admission_tick_size)));
    selectMarket(market.expiry_market_id);
    setStrikeOffset(Math.round((c.strike - atm) / step));
    // A surface pick is a full side-&-level choice — advance the ticket to
    // its bet step (legacy parity).
    markPicked();
  }

  return (
    <group>
      <mesh geometry={geometry} onClick={pick} onPointerMove={handleMove} onPointerOut={() => onHover(null)}>
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
      <mesh geometry={geometry} raycast={() => null}>
        <meshBasicMaterial wireframe transparent opacity={0.1} color="#ffffff" />
      </mesh>
    </group>
  );
}

/** Small red spheres at butterfly/calendar-violating cells (arb overlay). */
function ArbMarkers({ surface, mesh }: { surface: Surface; mesh: SurfaceMesh }) {
  const cols = surface.kGrid.length;
  const marks = useMemo(() => {
    const out: [number, number, number][] = [];
    surface.rows.forEach((r, ri) => {
      r.cells.forEach((c, ci) => {
        if (!c.butterfly && !c.calendar) return;
        const y = mesh.positions[(ri * cols + ci) * 3 + 1];
        out.push([mesh.colMeta[ci].x, y, mesh.rowMeta[ri].z]);
      });
    });
    return out;
  }, [surface, mesh, cols]);

  return (
    <group>
      {marks.map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.06, 10, 10]} />
          <meshBasicMaterial color="#f0796b" />
        </mesh>
      ))}
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
}: {
  expiries: number;
  hasButterfly: boolean;
  hasCalendar: boolean;
}) {
  const arb = hasButterfly || hasCalendar;
  return (
    <div className="pointer-events-none absolute right-5 top-5 flex flex-col items-end gap-2">
      <div className="flex items-center gap-2">
        <span className="font-mono text-[11px] font-medium tracking-tight text-text-1">BTC</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">SVI surface · live</span>
      </div>
      <span className="font-mono text-[10px] tabular-nums text-text-3">{expiries} expiries</span>
      <span
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-[10px] uppercase tracking-wider ${
          arb ? 'bg-(--down-soft) text-down' : 'bg-(--accent-soft) text-accent'
        }`}
      >
        {arb
          ? `${[hasButterfly && 'butterfly', hasCalendar && 'calendar'].filter(Boolean).join(' · ')} arb`
          : 'no-arb'}
      </span>
    </div>
  );
}

function SurfaceControls({ stress, onStress }: { stress: boolean; onStress: (v: boolean) => void }) {
  return (
    <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-lg bg-white/2 p-0.5 backdrop-blur-xl">
      <button
        onClick={() => onStress(!stress)}
        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors ${
          stress ? 'bg-(--down-soft) text-down' : 'text-text-3 hover:text-text-1'
        }`}
      >
        <LuActivity size={12} />
        Stress
      </button>
      <span className="pr-1.5">
        <InfoTip label="stress test">
          Perturbs the pricing model to show what an inconsistent (arbitrage-able) surface would look
          like — the checker flags it in red. Live prices are normally clean.
        </InfoTip>
      </span>
    </div>
  );
}

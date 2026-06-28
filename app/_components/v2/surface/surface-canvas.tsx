'use client';

/**
 * SurfaceCanvasV2 — the live SVI vol surface for the new deployment.
 *
 * Reuses the proven pure math (buildSurface + buildSurfaceMesh) but is a LEAN,
 * v2-wired renderer (no legacy surface-store, no range mode, no in-canvas popover):
 * strike × expiry × IV, clickable to select a market + strike into the v2 trade
 * store. X = log-moneyness, Z = expiry depth, Y/colour = implied vol.
 */
import { useMemo } from 'react';
import { Canvas, type ThreeEvent } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { buildSurface, type SmileInput, type Surface } from '@/lib/svi/surface';
import { buildSurfaceMesh, type SurfaceMesh } from '@/lib/svi/mesh';
import { useV2TradeStore } from '@/lib/store/v2-trade-store';
import { toFloat, fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from '@/lib/sui/v2/ticks';
import type { V2Market } from '@/lib/api/v2/types';

export function SurfaceCanvasV2({
  inputs,
  markets,
  serverNow,
}: {
  inputs: SmileInput[];
  markets: V2Market[];
  serverNow: number;
}) {
  const surface = useMemo(() => buildSurface(inputs, { nowMs: serverNow }), [inputs, serverNow]);
  const mesh = useMemo(() => buildSurfaceMesh(surface), [surface]);

  return (
    <Canvas camera={{ position: [0, 4.5, 9], fov: 42 }} dpr={[1, 2]} className="cursor-grab active:cursor-grabbing">
      <ambientLight intensity={0.75} />
      <directionalLight position={[5, 9, 6]} intensity={0.5} />
      <group position={[0, -mesh.height / 2, 0]}>
        <SurfaceMesh surface={surface} mesh={mesh} markets={markets} />
      </group>
      <OrbitControls
        autoRotate
        autoRotateSpeed={0.55}
        enablePan={false}
        enableZoom
        minDistance={6}
        maxDistance={16}
        minPolarAngle={0.35}
        maxPolarAngle={1.35}
        target={[0, 0, 0]}
      />
    </Canvas>
  );
}

function SurfaceMesh({ surface, mesh, markets }: { surface: Surface; mesh: SurfaceMesh; markets: V2Market[] }) {
  const selectMarket = useV2TradeStore((s) => s.selectMarket);
  const setStrikeOffset = useV2TradeStore((s) => s.setStrikeOffset);

  const geometry = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions, 3));
    g.setAttribute('color', new THREE.BufferAttribute(mesh.colors, 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    return g;
  }, [mesh]);

  function pick(e: ThreeEvent<MouseEvent>) {
    e.stopPropagation();
    const p = e.point;
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
    // The mesh is offset by -height/2 (parent group), so undo it for x/z (unaffected).
    const col = nearest(mesh.colMeta.map((c) => c.x), p.x);
    const row = nearest(mesh.rowMeta.map((r) => r.z), p.z);
    const sRow = surface.rows[row];
    const market = markets.find((m) => m.expiry_market_id === sRow.oracleId);
    if (!market) return;
    const strike = sRow.forward * Math.exp(surface.kGrid[col]);
    const step = toFloat(market.admission_tick_size) || 1;
    const atm = toFloat(snapStrikeToAdmission(fromFloat(sRow.forward), BigInt(market.admission_tick_size)));
    selectMarket(market.expiry_market_id);
    setStrikeOffset(Math.round((strike - atm) / step));
  }

  return (
    <mesh geometry={geometry} onClick={pick}>
      <meshStandardMaterial vertexColors side={THREE.DoubleSide} roughness={0.62} metalness={0.05} />
    </mesh>
  );
}

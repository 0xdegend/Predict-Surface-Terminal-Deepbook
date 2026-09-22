'use client';

/**
 * kelly-stage.tsx — Kelly, standing on the live volatility surface.
 *
 * WHY THIS AND NOT A NEW SCENE. The app already renders a 3-D SVI surface from live
 * pricers, and that surface is the thing Autopilot is actually trading. Putting Kelly in a
 * generic room would have meant building a second world to animate, and everything in it
 * would have been decoration. Standing her on the surface costs one mesh we already know
 * how to build, and then every single thing that moves on screen is real: the relief is
 * live implied vol, her position is the strike she would buy, and the markers around her
 * are the markets the engine actually ranked this tick (see lib/autopilot/scan.ts).
 *
 * This file deliberately does NOT import from the trade screen's surface canvas. It shares
 * the pure math (buildSurface / buildSurfaceMesh) and nothing else, so nothing here can
 * regress the screen traders place orders on.
 *
 * KELLY IS A BILLBOARDED SPRITE, NOT A MODEL. There is no 3-D fox asset and inventing one
 * is an art commission, not a code change. She is the existing mascot artwork on a plane
 * that turns to face the camera while staying upright, which reads as a character in a 3-D
 * world and swaps expression instantly. If a real model ever arrives it drops in here.
 *
 * All behaviour (which beat, which mood, where she stands) is decided in
 * lib/autopilot/stage-state.ts. This file only draws the answer.
 */
import { useMemo, useRef, useEffect, Suspense } from 'react';
import * as THREE from 'three';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Billboard, useTexture } from '@react-three/drei';
import { buildSurface, type Surface } from '@/lib/svi/surface';
import { buildSurfaceMesh, type SurfaceMesh } from '@/lib/svi/mesh';
import type { Oracle } from '@/lib/api/types';
import type { LivePricer } from '@/lib/sui/v2/pricer';
import type { V2Market } from '@/lib/api/v2/types';
import { MASCOT_SRC, type MascotMood } from '@/lib/mascot';
import type { ScanRow } from '@/lib/autopilot/scan';
import type { StageBeat, StagePosition } from '@/lib/autopilot/stage-state';

/** The k window the stage draws. Tighter than the trade screen's: Autopilot buys close to
 *  the money, so a wide window would spend most of the frame on strikes it never touches. */
const K_GRID = { kMin: -0.05, kMax: 0.05, kSteps: 41 } as const;

/** Per-frame easing, `a = 1 - ease^delta`, so motion is frame-rate independent. */
const EASE_SURFACE = 0.02;
const EASE_KELLY = 0.006;
const EASE_CAMERA = 0.08;

export interface StageProps {
  /** The engine's priceable universe. One row of the surface per market. */
  candidates: { market: V2Market; pricer: LivePricer }[];
  /** What the engine ranked this tick, for the markers. */
  rows: ScanRow[];
  positions: StagePosition[];
  focusMarketId: string | null;
  /** The page's clock, passed in so the scene stays a pure function of its props. */
  now: number;
  mood: MascotMood;
  beat: StageBeat;
  energy: number;
  reduced: boolean;
}

/* ─────────────────────────── surface placement ─────────────────────────── */

/** The surface row for a market, matched on its expiry (one row per expiry). */
function rowForExpiry(mesh: SurfaceMesh, expiry: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let r = 0; r < mesh.rowMeta.length; r++) {
    const gap = Math.abs(mesh.rowMeta[r].expiry - expiry);
    if (gap < bestGap) {
      bestGap = gap;
      best = r;
    }
  }
  return best;
}

/** The column nearest a log-moneyness. k = 0 lands at the money, which is the fallback. */
function colForK(mesh: SurfaceMesh, k: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let c = 0; c < mesh.colMeta.length; c++) {
    const gap = Math.abs(mesh.colMeta[c].k - k);
    if (gap < bestGap) {
      bestGap = gap;
      best = c;
    }
  }
  return best;
}

/** A point ON the surface, in world space. */
function surfacePoint(mesh: SurfaceMesh, expiry: number, k: number, out = new THREE.Vector3()): THREE.Vector3 {
  const r = rowForExpiry(mesh, expiry);
  const c = colForK(mesh, k);
  const i = (r * mesh.cols + c) * 3;
  return out.set(mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]);
}

/* ────────────────────────────── the surface ────────────────────────────── */

/**
 * The live surface, easing toward each new build rather than snapping.
 *
 * One persistent geometry for the life of the scene. Markets roll every minute, so the row
 * count changes underneath us; when it does the geometry is rebuilt, and otherwise the
 * vertices just travel. That travel is the "breathing" the whole scene rests on, and it is
 * real: it is implied vol moving.
 */
function MorphSurface({ mesh, reduced }: { mesh: SurfaceMesh; reduced: boolean }) {
  // Keyed on the vertex COUNT, not on the data: a new row count is a new geometry, while
  // the same grid with new heights is the same geometry travelling, which is the morph.
  const geom = useMemo(() => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(mesh.positions.slice(), 3));
    g.setAttribute('color', new THREE.BufferAttribute(mesh.colors.slice(), 3));
    g.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    g.computeVertexNormals();
    return g;
  }, [mesh.rows, mesh.cols]); // eslint-disable-line react-hooks/exhaustive-deps

  // Markets roll every minute, so a run rebuilds this geometry many times over its life.
  // Without the dispose each rebuild would strand its buffers on the GPU for as long as
  // the tab stayed open, which on an unattended run is exactly the case that matters.
  useEffect(() => () => geom.dispose(), [geom]);

  // No ref for the target: useFrame always runs the LATEST closure, so `mesh` here is
  // already the current build on every frame (the same reasoning as SurfacePositionPins).
  useFrame((_, delta) => {
    const g = geom;
    const target = mesh.positions;
    const pos = g.getAttribute('position') as THREE.BufferAttribute;
    const col = g.getAttribute('color') as THREE.BufferAttribute;
    if (pos.array.length !== target.length) return; // a rebuild is one render away
    const a = reduced ? 1 : 1 - Math.pow(EASE_SURFACE, delta);
    const p = pos.array as Float32Array;
    for (let i = 0; i < p.length; i++) p[i] += (target[i] - p[i]) * a;
    const c = col.array as Float32Array;
    for (let i = 0; i < c.length; i++) c[i] += (mesh.colors[i] - c[i]) * a;
    pos.needsUpdate = true;
    col.needsUpdate = true;
    g.computeVertexNormals();
  });

  return (
    <group>
      <mesh geometry={geom}>
        <meshStandardMaterial
          vertexColors
          side={THREE.DoubleSide}
          roughness={0.62}
          metalness={0.08}
          transparent
          opacity={0.94}
        />
      </mesh>
      {/* A hairline wireframe over the top. The surface reads as a grid a trader can
          count rows on, rather than as a smooth blob. */}
      <mesh geometry={geom}>
        <meshBasicMaterial wireframe transparent opacity={0.07} color="#9fb4c7" />
      </mesh>
    </group>
  );
}

/* ───────────────────────────── the candidates ──────────────────────────── */

/**
 * One marker per market the engine rated this tick.
 *
 * This is the honest version of a "scanning" animation. Kelly's pick is rule-based and
 * resolves in milliseconds, so staging a deliberation would be depicting thinking that
 * never happened, in an app whose whole credibility rests on a track record you can check.
 * Instead: the markets she really looked at, at their real strikes, sized by the value she
 * really scored them at, with the ones that cleared the trader's rules lit and the rest
 * left dim. Nothing invented, and more interesting than suspense would have been.
 */
function CandidateMarkers({
  mesh,
  rows,
  focusMarketId,
  reduced,
}: {
  mesh: SurfaceMesh;
  rows: ScanRow[];
  focusMarketId: string | null;
  reduced: boolean;
}) {
  const group = useRef<THREE.Group>(null);

  useFrame((state) => {
    if (!group.current || reduced) return;
    const t = state.clock.elapsedTime;
    group.current.children.forEach((child, i) => {
      // A slow, staggered bob so the board reads as alive without any of them competing
      // with Kelly for attention.
      child.position.y = (child.userData.baseY as number) + Math.sin(t * 1.1 + i * 0.7) * 0.06;
    });
  });

  return (
    <group ref={group}>
      {rows.map((r) => {
        const p = surfacePoint(mesh, r.expiry, r.k);
        const focused = r.marketId === focusMarketId;
        // Value, not win chance, drives the size: that is what the engine ranks on.
        const scale = 0.1 + Math.min(Math.max(r.edge, 0), 0.2) * 1.4 + (focused ? 0.08 : 0);
        const color = r.clears ? (r.side === 'down' ? '#f0836b' : '#4fd1a5') : '#5d6b7a';
        return (
          <mesh
            key={r.marketId}
            position={[p.x, p.y + 0.22, p.z]}
            userData={{ baseY: p.y + 0.22 }}
            scale={scale}
          >
            <icosahedronGeometry args={[1, 0]} />
            <meshStandardMaterial
              color={color}
              emissive={color}
              emissiveIntensity={focused ? 1.5 : r.clears ? 0.7 : 0.18}
              roughness={0.35}
            />
          </mesh>
        );
      })}
    </group>
  );
}

/* ────────────────────────────── open trades ────────────────────────────── */

/** A pin per open trade, tinted by live PnL. The money actually on the table. */
function PositionPins({ mesh, positions }: { mesh: SurfaceMesh; positions: StagePosition[] }) {
  return (
    <group>
      {positions.map((p) => {
        const pt = surfacePoint(mesh, p.expiry, 0);
        const up = p.pnlUsd >= 0;
        const color = up ? '#4fd1a5' : '#f0836b';
        return (
          <group key={`${p.marketId}:${p.expiry}`} position={[pt.x, pt.y, pt.z]}>
            {/* A stem so an open trade is visible even when the surface dips under it. */}
            <mesh position={[0, 0.45, 0]}>
              <cylinderGeometry args={[0.012, 0.012, 0.9, 6]} />
              <meshBasicMaterial color={color} transparent opacity={0.5} />
            </mesh>
            <mesh position={[0, 0.95, 0]}>
              <octahedronGeometry args={[0.13, 0]} />
              <meshStandardMaterial color={color} emissive={color} emissiveIntensity={1.1} roughness={0.3} />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}

/* ──────────────────────────────── Kelly ────────────────────────────────── */

function Kelly({
  mesh,
  target,
  mood,
  beat,
  energy,
  reduced,
}: {
  mesh: SurfaceMesh;
  target: { expiry: number; k: number } | null;
  mood: MascotMood;
  beat: StageBeat;
  energy: number;
  reduced: boolean;
}) {
  const textures = useTexture({
    thinking: MASCOT_SRC.thinking,
    confident: MASCOT_SRC.confident,
    won: MASCOT_SRC.won,
    loss: MASCOT_SRC.loss,
  });
  const group = useRef<THREE.Group>(null);
  const shadow = useRef<THREE.Mesh>(null);
  const want = useRef(new THREE.Vector3(0, 0, 0));
  const here = useRef(new THREE.Vector3(0, 0, 0));

  useFrame((state, delta) => {
    const g = group.current;
    if (!g) return;
    // Where she should be: on the surface, at the market she is working on. With no
    // target she drifts to the middle of the board rather than freezing at the origin.
    if (target) surfacePoint(mesh, target.expiry, target.k, want.current);
    else want.current.set(0, mesh.height * 0.35, 0);

    const a = reduced ? 1 : 1 - Math.pow(EASE_KELLY, delta);
    here.current.lerp(want.current, a);

    const t = state.clock.elapsedTime;
    // Idle motion scaled by the beat's energy. This is the difference between waiting and
    // working being legible before you have read a word: scouting sways, placing snaps.
    const sway = reduced ? 0 : Math.sin(t * (1.1 + energy * 1.6)) * 0.035 * (0.3 + energy);
    const bob = reduced ? 0 : Math.abs(Math.sin(t * (1.4 + energy * 2.2))) * 0.07 * energy;
    g.position.set(here.current.x + sway, here.current.y + 0.52 + bob, here.current.z);

    // A brief, proportionate scale beat on a result. Deliberately small: an expression
    // change is character, a celebration is a slot machine.
    const pop = beat === 'won' ? 1.06 : beat === 'lost' ? 0.96 : 1;
    const s = g.scale.x + (pop - g.scale.x) * (1 - Math.pow(0.02, delta));
    g.scale.setScalar(s);

    if (shadow.current) {
      shadow.current.position.set(here.current.x, here.current.y + 0.015, here.current.z);
      const m = shadow.current.material as THREE.MeshBasicMaterial;
      m.opacity = 0.28 - bob * 0.8;
    }
  });

  const map = textures[mood] ?? textures.thinking;

  return (
    <group>
      {/* Contact shadow. Without it she reads as pasted on top of the surface rather
          than standing on it, which is the whole illusion. */}
      <mesh ref={shadow} rotation={[-Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.3, 24]} />
        <meshBasicMaterial color="#000000" transparent opacity={0.28} depthWrite={false} />
      </mesh>
      <group ref={group}>
        <Billboard follow lockX lockZ>
          <mesh>
            <planeGeometry args={[1.05, 1.05]} />
            <meshBasicMaterial map={map} transparent alphaTest={0.12} toneMapped={false} />
          </mesh>
        </Billboard>
      </group>
    </group>
  );
}

/* ──────────────────────────────── camera ───────────────────────────────── */

/** Follows Kelly at a respectful distance, and never cuts. A cut would read as a
 *  highlight reel; a drift reads as watching someone work. */
function CameraRig({ focus, reduced }: { focus: THREE.Vector3; reduced: boolean }) {
  const { camera } = useThree();
  const look = useRef(new THREE.Vector3(0, 1, 0));

  useFrame((state, delta) => {
    const a = reduced ? 1 : 1 - Math.pow(EASE_CAMERA, delta);
    const t = state.clock.elapsedTime;
    // A slow orbit so the relief is readable as relief. Amplitude is small on purpose:
    // this is a surface being watched, not a camera showing off.
    const wantX = focus.x * 0.45 + Math.sin(t * 0.08) * 1.1;
    const wantZ = focus.z * 0.45 + 7.4 + Math.cos(t * 0.08) * 0.5;
    const wantY = focus.y + 3.1;
    camera.position.lerp(new THREE.Vector3(wantX, wantY, wantZ), a);
    look.current.lerp(focus, a);
    camera.lookAt(look.current);
  });

  return null;
}

/* ───────────────────────────────  scene  ───────────────────────────────── */

function Scene({ candidates, rows, positions, focusMarketId, mood, beat, energy, reduced, now }: StageProps) {
  // The same surface the trade screen draws, from the same live pricers, via the same
  // pure math. Only the k window differs (see K_GRID).
  const surface = useMemo<Surface | null>(() => {
    const inputs = candidates
      .filter((c) => c.market.expiry > now + 5_000)
      .map((c) => ({
        // buildSurface reads only oracle_id / expiry / underlying_asset off the oracle.
        oracle: {
          oracle_id: c.market.expiry_market_id,
          expiry: c.market.expiry,
          underlying_asset: 'BTC',
        } as unknown as Oracle,
        svi: c.pricer.svi,
        forward: c.pricer.forward,
      }));
    return inputs.length ? buildSurface(inputs, { ...K_GRID, nowMs: now }) : null;
  }, [candidates, now]);

  const mesh = useMemo(() => (surface ? buildSurfaceMesh(surface) : null), [surface]);

  // Where the camera and Kelly are headed. Derived from the SAME rows the markers use, so
  // she is always standing on something the trader can see and check.
  const target = useMemo(() => {
    if (!focusMarketId) return null;
    const row = rows.find((r) => r.marketId === focusMarketId);
    if (row) return { expiry: row.expiry, k: row.k };
    const pos = positions.find((p) => p.marketId === focusMarketId);
    return pos ? { expiry: pos.expiry, k: 0 } : null;
  }, [focusMarketId, rows, positions]);

  const focusPoint = useMemo(() => {
    if (!mesh) return new THREE.Vector3(0, 1.2, 0);
    return target ? surfacePoint(mesh, target.expiry, target.k) : new THREE.Vector3(0, mesh.height * 0.35, 0);
  }, [mesh, target]);

  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 8, 6]} intensity={1.1} />
      <directionalLight position={[-6, 4, -4]} intensity={0.35} color="#6ea8ff" />
      {mesh && (
        <>
          <MorphSurface mesh={mesh} reduced={reduced} />
          <CandidateMarkers mesh={mesh} rows={rows} focusMarketId={focusMarketId} reduced={reduced} />
          <PositionPins mesh={mesh} positions={positions} />
          <Kelly mesh={mesh} target={target} mood={mood} beat={beat} energy={energy} reduced={reduced} />
        </>
      )}
      <CameraRig focus={focusPoint} reduced={reduced} />
    </>
  );
}

export function KellyStage(props: StageProps) {
  return (
    <Canvas
      camera={{ position: [0, 4.2, 8], fov: 42 }}
      dpr={[1, 2]}
      gl={{ antialias: true, alpha: true }}
      // The scene is ambient, not interactive, so it must never fight the page for the
      // main thread while a trader is reading the numbers beside it.
      frameloop="always"
    >
      <Suspense fallback={null}>
        <Scene {...props} />
      </Suspense>
    </Canvas>
  );
}

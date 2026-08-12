'use client';

/**
 * RewardGiftScene — the Three.js gift that opens when a founding trader claims.
 *
 * One <Canvas>, driven entirely by the claim `phase` (no props change mid-frame
 * except the phase string): the wrapped box floats and turns at rest, rattles
 * while the payout is in flight, then bursts open — the lid flies off, a coin
 * rises and spins, a shockwave and a sparkle cloud bloom, and the accent light
 * flares. Mounted ssr:false by RewardGiftOverlay. Everything is disposed when the
 * overlay unmounts. Honors reduced motion (the overlay routes those users to the
 * modal instead, so `reduced` here is just a safety floor). See
 * [[founding-traders-reward]].
 */
import { useRef } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import type { RewardClaimPhase } from '@/lib/hooks/use-reward';

const ACCENT = new THREE.Color('#4dd6b0');
const CORAL = new THREE.Color('#f0796b');

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const easeOut = (x: number) => 1 - Math.pow(1 - clamp01(x), 3);

const isCharging = (p: RewardClaimPhase) => p === 'paying' || p === 'depositing';

function GiftRig({ phase, reduced, compact }: { phase: RewardClaimPhase; reduced: boolean; compact: boolean }) {
  const prev = useRef(phase);
  const t0 = useRef(-1);

  const box = useRef<THREE.Group>(null);
  const lid = useRef<THREE.Group>(null);
  const coin = useRef<THREE.Group>(null);
  const light = useRef<THREE.PointLight>(null);
  const flash = useRef<THREE.Mesh>(null);
  const burst = useRef<THREE.Group>(null);

  useFrame((state, delta) => {
    const t = state.clock.elapsedTime;
    if (t0.current < 0) t0.current = t;
    if (phase !== prev.current) {
      prev.current = phase;
      t0.current = t;
    }
    const since = t - t0.current;
    const reveal = phase === 'done';
    const charging = isCharging(phase);
    const error = phase === 'error';

    // whole gift: gentle bob + slow turn, escalating rattle while charging
    const b = box.current;
    if (b) {
      const bob = reduced ? 0 : Math.sin(t * 1.1) * 0.07;
      let jx = 0;
      let jz = 0;
      let rz = 0;
      if (charging && !reduced) {
        const amt = 0.05 * clamp01(since / 1.2);
        jx = Math.sin(t * 46) * amt;
        jz = Math.cos(t * 41) * amt;
        rz = Math.sin(t * 52) * amt * 0.35;
      }
      b.position.set(jx, bob, jz);
      b.rotation.z = rz;
      b.rotation.y = reduced ? 0.5 : t * 0.28;
    }

    // lid flies off on reveal
    const l = lid.current;
    if (l) {
      if (reveal) {
        const p = easeOut(since / 0.7);
        l.position.y = 0.775 + p * 3.4;
        l.rotation.z = p * 0.9;
        l.rotation.x = p * 0.5;
        const s = Math.max(0.001, 1 - p * 0.6);
        l.scale.setScalar(s);
        l.visible = s > 0.03;
      } else {
        l.position.y = 0.775;
        l.rotation.set(0, 0, 0);
        l.scale.setScalar(1);
        l.visible = true;
      }
    }

    // coin rises + spins out of the box on reveal
    const c = coin.current;
    if (c) {
      if (reveal) {
        const rise = easeOut(clamp01((since - 0.12) / 0.7));
        const pop = easeOut(clamp01((since - 0.12) / 0.45));
        c.visible = rise > 0.001;
        c.position.y = -0.2 + rise * 1.55;
        c.scale.setScalar(pop);
        const spin = 6 * Math.exp(-since * 0.8) + 1.4; // fast, then settles
        c.rotation.y += delta * spin;
      } else {
        c.visible = false;
        c.position.y = -0.2;
        c.scale.setScalar(0);
        c.rotation.y = 0;
      }
    }

    // accent light: pulse at rest, ramp while charging, flare on reveal
    const li = light.current;
    if (li) {
      let target = 8;
      if (charging) target = 8 + 16 * clamp01(since / 1.2);
      else if (reveal) target = 42 * Math.exp(-since * 1.6) + 14;
      else if (error) target = 5;
      else if (!reduced) target = 8 + Math.sin(t * 2) * 0.6;
      li.intensity += (target - li.intensity) * clamp01(delta * 8);
      li.color.copy(error ? CORAL : ACCENT);
    }

    // shockwave sphere on reveal
    const fl = flash.current;
    if (fl) {
      if (reveal && !reduced) {
        const p = easeOut(since / 0.5);
        fl.visible = p < 1;
        fl.scale.setScalar(0.4 + p * 4.6);
        (fl.material as THREE.MeshBasicMaterial).opacity = (1 - p) * 0.5;
      } else {
        fl.visible = false;
      }
    }

    // sparkle burst blooms outward and stays as a settled aura
    const bu = burst.current;
    if (bu) {
      if (reveal) {
        bu.visible = true;
        bu.scale.setScalar(0.2 + easeOut(since / 0.9) * 1.4);
      } else {
        bu.visible = false;
        bu.scale.setScalar(0.2);
      }
    }
  });

  const err = phase === 'error';
  const ribbon = err ? '#f0796b' : '#4dd6b0';
  const ribbonEm = err ? '#f0796b' : '#2f8f79';

  return (
    <>
      <ambientLight intensity={0.35} />
      <directionalLight position={[4, 8, 6]} intensity={0.9} />
      <directionalLight position={[-6, 3, -4]} intensity={0.3} color="#6fb7ff" />

      {/* ambient atmosphere — full-screen, so it stays behind everything */}
      <Sparkles count={60} scale={[11, 6, 7]} size={2} speed={0.3} opacity={0.5} color="#7fe6cf" noise={0.4} />

      {/* Keep the gift centered; on a phone the viewport is tall + narrow, so just
          scale it down a touch for side margin and to sit clear of the HUD below.
          Desktop keeps it full size. */}
      <group scale={compact ? 0.66 : 1}>
        <pointLight ref={light} position={[0, 0.7, 0.8]} intensity={8} distance={16} decay={1.4} color="#4dd6b0" />

        {/* burst cloud — hidden until reveal, then blooms */}
        <group ref={burst} visible={false}>
          <Sparkles count={90} scale={[4, 4, 4]} size={4} speed={0} opacity={0.9} color="#b8ffe9" />
        </group>

        {/* reveal shockwave */}
        <mesh ref={flash} position={[0, 0.3, 0]} visible={false}>
          <sphereGeometry args={[1, 24, 24]} />
          <meshBasicMaterial color="#b8ffe9" transparent opacity={0} depthWrite={false} blending={THREE.AdditiveBlending} />
        </mesh>

        <group ref={box}>
        {/* body */}
        <mesh>
          <boxGeometry args={[1.7, 1.15, 1.7]} />
          <meshStandardMaterial color="#161b20" metalness={0.35} roughness={0.55} />
        </mesh>
        {/* ribbon bands (stay with the body) */}
        <mesh>
          <boxGeometry args={[0.26, 1.17, 1.72]} />
          <meshStandardMaterial color={ribbon} emissive={ribbonEm} emissiveIntensity={0.6} metalness={0.4} roughness={0.35} />
        </mesh>
        <mesh>
          <boxGeometry args={[1.72, 1.17, 0.26]} />
          <meshStandardMaterial color={ribbon} emissive={ribbonEm} emissiveIntensity={0.6} metalness={0.4} roughness={0.35} />
        </mesh>

        {/* the coin, waiting inside */}
        <group ref={coin} position={[0, -0.2, 0]} visible={false}>
          <group rotation={[Math.PI / 2, 0, 0]}>
            <mesh>
              <cylinderGeometry args={[0.62, 0.62, 0.12, 48]} />
              <meshStandardMaterial color="#dCe8e4" metalness={0.75} roughness={0.28} emissive="#0c1a17" emissiveIntensity={0.15} />
            </mesh>
            {/* glowing rim around the edge */}
            <mesh rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.62, 0.05, 16, 48]} />
              <meshStandardMaterial color="#4dd6b0" emissive="#4dd6b0" emissiveIntensity={1.2} metalness={0.5} roughness={0.3} />
            </mesh>
            {/* engraved ring on the face toward the camera */}
            <mesh position={[0, 0.062, 0]} rotation={[Math.PI / 2, 0, 0]}>
              <torusGeometry args={[0.4, 0.028, 12, 40]} />
              <meshStandardMaterial color="#4dd6b0" emissive="#4dd6b0" emissiveIntensity={0.85} />
            </mesh>
          </group>
        </group>

        {/* lid + bow, flung off on reveal */}
        <group ref={lid} position={[0, 0.775, 0]}>
          <mesh>
            <boxGeometry args={[1.86, 0.4, 1.86]} />
            <meshStandardMaterial color="#1b2126" metalness={0.35} roughness={0.5} />
          </mesh>
          <group position={[0, 0.28, 0]}>
            <mesh position={[-0.18, 0, 0]} rotation={[0, 0, 0.5]}>
              <torusGeometry args={[0.2, 0.06, 12, 28]} />
              <meshStandardMaterial color={ribbon} emissive={ribbonEm} emissiveIntensity={0.7} metalness={0.4} roughness={0.35} />
            </mesh>
            <mesh position={[0.18, 0, 0]} rotation={[0, 0, -0.5]}>
              <torusGeometry args={[0.2, 0.06, 12, 28]} />
              <meshStandardMaterial color={ribbon} emissive={ribbonEm} emissiveIntensity={0.7} metalness={0.4} roughness={0.35} />
            </mesh>
            <mesh>
              <sphereGeometry args={[0.11, 20, 20]} />
              <meshStandardMaterial color={ribbon} emissive={ribbonEm} emissiveIntensity={0.8} metalness={0.4} roughness={0.3} />
            </mesh>
          </group>
        </group>
        </group>
      </group>
    </>
  );
}

export function RewardGiftScene({
  phase,
  reduced,
  compact,
}: {
  phase: RewardClaimPhase;
  reduced: boolean;
  compact: boolean;
}) {
  return (
    <Canvas camera={{ position: [0, 1.0, 6], fov: 42 }} dpr={[1, 2]} gl={{ antialias: true, alpha: true }}>
      <GiftRig phase={phase} reduced={reduced} compact={compact} />
    </Canvas>
  );
}

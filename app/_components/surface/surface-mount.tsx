'use client';

import dynamic from 'next/dynamic';
import type { SmileInput } from '@/lib/svi/surface';
import type { Oracle } from '@/lib/api/types';

// The R3F canvas is heavy and client-only — mount via next/dynamic with a
// designed skeleton so the terminal shell paints instantly (§7).
const SurfaceCanvas = dynamic(
  () => import('./surface-canvas').then((m) => m.SurfaceCanvas),
  { ssr: false, loading: () => <SurfaceSkeleton /> },
);

export function SurfaceMount({
  oracles,
  initialInputs,
}: {
  oracles: Oracle[];
  initialInputs: SmileInput[];
}) {
  if (initialInputs.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-[12px] text-text-3">
        No live SVI snapshots to render.
      </div>
    );
  }
  return <SurfaceCanvas oracles={oracles} initialInputs={initialInputs} />;
}

function SurfaceSkeleton() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      {/* Soft horizon glow standing in for the surface while Three.js hydrates. */}
      <div className="absolute inset-x-0 bottom-1/4 top-1/4 animate-pulse bg-[radial-gradient(60%_80%_at_50%_60%,rgba(45,130,150,0.22),transparent_72%)]" />
      {/* Skeleton chrome that matches the final overlay positions (§10.7). */}
      <div className="absolute left-5 top-1/2 h-40 w-1.5 -translate-y-1/2 animate-pulse rounded-full bg-white/[0.05]" />
      <div className="absolute right-5 top-5 h-4 w-24 animate-pulse rounded bg-white/[0.05]" />
      <div className="absolute bottom-5 left-1/2 h-12 w-80 -translate-x-1/2 animate-pulse rounded-xl bg-white/[0.04]" />
      <span className="absolute bottom-[5.25rem] left-1/2 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-3">
        assembling surface…
      </span>
    </div>
  );
}

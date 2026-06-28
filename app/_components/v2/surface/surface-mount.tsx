'use client';

/**
 * SurfaceMountV2 — lazily loads the heavy Three.js surface (ssr:false) behind a
 * designed skeleton so the shell paints instantly. Needs ≥2 expiries to form a
 * surface; the caller only renders this when that holds.
 */
import dynamic from 'next/dynamic';
import type { SmileInput } from '@/lib/svi/surface';
import type { V2Market } from '@/lib/api/v2/types';

const SurfaceCanvasV2 = dynamic(() => import('./surface-canvas').then((m) => m.SurfaceCanvasV2), {
  ssr: false,
  loading: () => <SurfaceSkeleton />,
});

export function SurfaceMountV2(props: { inputs: SmileInput[]; markets: V2Market[]; serverNow: number }) {
  return <SurfaceCanvasV2 {...props} />;
}

function SurfaceSkeleton() {
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="absolute inset-x-0 bottom-1/4 top-1/4 animate-pulse bg-[radial-gradient(60%_80%_at_50%_60%,rgba(45,130,150,0.2),transparent_72%)]" />
      <span className="absolute bottom-4 left-1/2 -translate-x-1/2 font-mono text-[10px] uppercase tracking-[0.18em] text-text-3">
        assembling surface…
      </span>
    </div>
  );
}

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
    <div className="flex h-full w-full items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-24 w-48 animate-pulse rounded bg-[radial-gradient(ellipse_at_center,rgba(45,120,140,0.25),transparent_70%)]" />
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-3">
          assembling surface…
        </span>
      </div>
    </div>
  );
}

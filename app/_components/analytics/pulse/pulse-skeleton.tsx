/**
 * PulseSkeleton — the loading state for the dashboard, mirroring the live bento
 * (KPI strip · fixed-height hero · full-width feed) so there's zero layout shift
 * when data arrives. Pure shimmer blocks, no data.
 */
import { Skeleton } from '../charts/skeleton';

export function PulseSkeleton() {
  return (
    <div className="space-y-3">
      {/* KPI strip */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="glass-inset flex items-center gap-3 p-3">
            <Skeleton className="h-8 w-8 rounded-lg" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-2.5 w-16" />
              <Skeleton className="h-4 w-12" />
            </div>
          </div>
        ))}
      </div>

      {/* Hero */}
      <div className="grid gap-3 lg:h-100 lg:grid-cols-3">
        <div className="glass-card lg:col-span-2 lg:h-full">
          <CardHead />
          <div className="space-y-3 p-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="flex items-center justify-between gap-3">
                <div className="flex-1 space-y-1.5">
                  <Skeleton className="h-3 w-28" />
                  <Skeleton className="h-1 w-44 rounded-full" />
                </div>
                <Skeleton className="h-4 w-14" />
              </div>
            ))}
          </div>
        </div>
        <div className="flex flex-col gap-3 lg:col-span-1 lg:h-full">
          <div className="glass-card flex-1 p-4">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="mt-3 h-5 w-40" />
            <Skeleton className="mt-3 h-2.5 w-full rounded-full" />
            <div className="mt-3 flex justify-between">
              <Skeleton className="h-3 w-20" />
              <Skeleton className="h-3 w-20" />
            </div>
          </div>
          <div className="glass-card flex-1 p-4">
            <Skeleton className="h-3 w-24" />
            <Skeleton className="mt-3 h-6 w-16" />
            <Skeleton className="mt-3 h-9 w-full" />
          </div>
        </div>
      </div>

      {/* Live feed */}
      <div className="glass-card">
        <CardHead />
        <div className="space-y-3 p-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="flex items-center gap-2.5">
              <Skeleton className="h-5 w-5 rounded-md" />
              <Skeleton className="h-4 w-4 rounded-full" />
              <Skeleton className="h-3 w-24" />
              <Skeleton className="ml-auto h-3 w-20" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function CardHead() {
  return (
    <div className="head-divider flex items-center gap-2 px-4 py-3">
      <Skeleton className="h-4 w-4 rounded" />
      <Skeleton className="h-3 w-28" />
    </div>
  );
}

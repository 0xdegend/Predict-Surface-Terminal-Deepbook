/**
 * page-skeletons.tsx — route-level loading skeletons that mirror each page's
 * real layout, so navigation paints the page's shape immediately instead of a
 * blanking preloader (§10.7). Shared primitives (Skel / ChromeSkeleton /
 * PageSkeleton) keep every page consistent; each export below fills the body.
 *
 * Pure markup → Server Components. Pulse is gated on `motion-safe` so
 * reduced-motion users get static blocks. All blocks are aria-hidden behind a
 * single role="status" so screen readers hear one "Loading…", not a wall of divs.
 */
import type { ReactNode } from 'react';

/** One shimmer block in the shared skeleton vocabulary. */
export function Skel({ className = '' }: { className?: string }) {
  return <div className={`rounded-md bg-white/5 motion-safe:animate-pulse ${className}`} />;
}

/** The h-16 top-chrome header skeleton — matches TopChrome on every route. */
export function ChromeSkeleton() {
  return (
    <header
      aria-hidden
      className="glass sticky top-0 z-40 grid h-16 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-b px-3 sm:gap-4 sm:px-5 lg:grid-cols-[1fr_auto_1fr]"
    >
      <div className="flex items-center gap-3 sm:gap-5">
        <div className="flex items-center gap-2">
          <Skel className="h-5.5 w-5.5 rounded" />
          <Skel className="hidden h-3.5 w-14 sm:block" />
        </div>
        <div className="hidden items-center gap-3 lg:flex">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skel key={i} className="h-3 w-16" />
          ))}
        </div>
      </div>
      <div className="flex justify-center">
        <Skel className="h-9 w-44 rounded-lg sm:w-56" />
      </div>
      <div className="flex items-center justify-end gap-2">
        <Skel className="h-9 w-9 rounded-lg" />
        <Skel className="h-9 w-40 rounded-lg sm:w-48" />
      </div>
    </header>
  );
}

/** Standard page shell: chrome + a centered main the body fills. */
export function PageSkeleton({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col" role="status" aria-busy="true">
      <span className="sr-only">{label}</span>
      <ChromeSkeleton />
      <main aria-hidden className="flex flex-1 flex-col">
        {children}
      </main>
    </div>
  );
}

/** A framed glass-card placeholder of a given height. */
function CardSkel({ className = '' }: { className?: string }) {
  return <div className={`rounded-2xl border border-white/5 bg-white/2 motion-safe:animate-pulse ${className}`} />;
}

/* ============================ Portfolio ============================ */

export function PortfolioSkeleton() {
  return (
    <PageSkeleton label="Loading your portfolio…">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5">
        {/* account-value bento */}
        <div className="mb-6 grid grid-cols-2 gap-2.5 rounded-2xl border border-white/5 p-2.5 lg:grid-cols-3">
          <div className="col-span-2 flex flex-col gap-3 rounded-xl bg-white/2 p-4 lg:col-span-1">
            <Skel className="h-3 w-24" />
            <Skel className="h-8 w-40" />
            <Skel className="h-3 w-28" />
          </div>
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl bg-white/2 p-4">
              <Skel className="h-3 w-20" />
              <Skel className="h-5 w-24" />
            </div>
          ))}
        </div>

        {/* tab strip */}
        <div className="mb-4 flex items-center justify-between gap-3">
          <Skel className="h-9 w-60 rounded-lg" />
          <Skel className="h-3.5 w-32" />
        </div>

        {/* position cards */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <CardSkel key={i} className="h-60" />
          ))}
        </div>
      </div>
    </PageSkeleton>
  );
}

/* ============================ Leaderboard ============================ */

const LB_COLS = 'grid-cols-[2rem_1fr_4.5rem_4.5rem] sm:grid-cols-[2.5rem_1fr_7rem_7rem]';

export function LeaderboardSkeleton() {
  return (
    <PageSkeleton label="Loading the leaderboard…">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
        {/* header */}
        <div className="mb-5 flex items-end justify-between gap-4">
          <Skel className="h-6 w-44" />
          <Skel className="h-8 w-24 rounded-lg" />
        </div>

        {/* stat strip */}
        <div className="mb-5 grid grid-cols-3 gap-2.5 rounded-2xl border border-white/5 p-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl bg-white/2 p-3.5">
              <Skel className="h-3 w-16" />
              <Skel className="h-5 w-20" />
            </div>
          ))}
        </div>

        {/* table */}
        <div className="overflow-hidden rounded-2xl border border-white/5">
          <div className={`grid ${LB_COLS} items-center gap-2 border-b border-white/5 px-4 py-3`}>
            <Skel className="h-3 w-4" />
            <Skel className="h-3 w-24" />
            <Skel className="ml-auto h-3 w-12" />
            <Skel className="ml-auto h-3 w-12" />
          </div>
          {Array.from({ length: 9 }).map((_, i) => (
            <div key={i} className={`grid ${LB_COLS} items-center gap-2 px-4 py-3.5`}>
              <Skel className="h-4 w-5" />
              <span className="flex items-center gap-2.5">
                <Skel className="h-6 w-6 rounded-full" />
                <Skel className="h-4 w-28" />
              </span>
              <Skel className="ml-auto h-4 w-14" />
              <Skel className="ml-auto h-4 w-12" />
            </div>
          ))}
        </div>
      </div>
    </PageSkeleton>
  );
}

/* ============================ Vault ============================ */

export function VaultSkeleton() {
  return (
    <PageSkeleton label="Loading the vault…">
      <div className="mx-auto w-full max-w-2xl px-4 py-6 sm:px-5">
        <div className="mb-5 flex flex-col gap-2">
          <Skel className="h-6 w-40" />
          <Skel className="h-3.5 w-72 max-w-full" />
        </div>
        {/* supply form */}
        <div className="flex flex-col gap-4 rounded-2xl border border-white/5 p-4">
          <Skel className="h-3 w-28" />
          <Skel className="h-11 rounded-lg" />
          <Skel className="h-12 rounded-lg" />
          <div className="grid grid-cols-2 gap-2.5">
            <Skel className="h-14 rounded-xl" />
            <Skel className="h-14 rounded-xl" />
          </div>
        </div>
        {/* your position */}
        <div className="mt-8 mb-4 flex items-center gap-2">
          <Skel className="h-4 w-36" />
        </div>
        <CardSkel className="h-44" />
      </div>
    </PageSkeleton>
  );
}

/* ============================ Vault Risk ============================ */

export function RiskSkeleton() {
  return (
    <PageSkeleton label="Loading vault risk…">
      <div className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-5">
        <div className="mb-5">
          <Skel className="h-6 w-40" />
        </div>
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[1fr_400px]">
          <div className="flex flex-col gap-5">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="flex flex-col gap-4 rounded-2xl border border-white/5 p-5">
                <Skel className="h-4 w-32" />
                <Skel className="h-8 w-44" />
                <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
                  {Array.from({ length: 4 }).map((_, j) => (
                    <Skel key={j} className="h-12 rounded-lg" />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-5">
            {Array.from({ length: 2 }).map((_, i) => (
              <CardSkel key={i} className="h-64" />
            ))}
          </div>
        </div>
      </div>
    </PageSkeleton>
  );
}

/* ============================ Trader profile ============================ */

export function TraderSkeleton() {
  return (
    <PageSkeleton label="Loading trader profile…">
      <div className="mx-auto w-full max-w-3xl px-4 py-6 sm:px-5">
        <Skel className="mb-4 h-3.5 w-28" />
        {/* identity card */}
        <div className="mb-5 flex flex-wrap items-center gap-x-5 gap-y-4 rounded-2xl border border-white/5 p-4">
          <Skel className="h-12 w-12 rounded-full" />
          <div className="flex min-w-0 flex-col gap-2">
            <Skel className="h-5 w-40" />
            <Skel className="h-4 w-32" />
          </div>
          <div className="ml-auto flex flex-col items-end gap-2">
            <Skel className="h-3 w-16" />
            <Skel className="h-6 w-24" />
          </div>
        </div>
        {/* stat bento */}
        <div className="mb-6 grid grid-cols-3 gap-2.5 rounded-2xl border border-white/5 p-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="flex flex-col gap-2 rounded-xl bg-white/2 p-3">
              <Skel className="h-3 w-16" />
              <Skel className="h-5 w-20" />
            </div>
          ))}
        </div>
        {/* positions */}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          {Array.from({ length: 2 }).map((_, i) => (
            <CardSkel key={i} className="h-52" />
          ))}
        </div>
      </div>
    </PageSkeleton>
  );
}

/* ============================ Competitions ============================ */

export function CompetitionsSkeleton() {
  return (
    <PageSkeleton label="Loading competitions…">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
        <div className="mb-6 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Skel className="h-6 w-40" />
            <Skel className="h-6 w-28 rounded-full" />
          </div>
          <Skel className="h-4 w-full max-w-2xl" />
        </div>
        {/* season hero */}
        <CardSkel className="h-56" />
        {/* prize split */}
        <div className="mt-3 grid grid-cols-2 gap-2.5 rounded-2xl border border-white/5 p-2.5 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skel key={i} className="h-16 rounded-xl" />
          ))}
        </div>
        {/* podium */}
        <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <CardSkel key={i} className="h-44" />
          ))}
        </div>
      </div>
    </PageSkeleton>
  );
}

/* ============================ Quests ============================ */

export function QuestsSkeleton() {
  return (
    <PageSkeleton label="Loading quests…">
      <div className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-5">
        <div className="mb-6 flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Skel className="h-6 w-32" />
            <Skel className="h-6 w-28 rounded-full" />
          </div>
          <Skel className="h-4 w-full max-w-2xl" />
        </div>
        {/* how it works */}
        <div className="mb-6 grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skel key={i} className="h-16 rounded-xl" />
          ))}
        </div>
        {/* summary strip */}
        <div className="mb-5 grid grid-cols-3 gap-2.5 rounded-2xl border border-white/5 p-2.5">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skel key={i} className="h-14 rounded-xl" />
          ))}
        </div>
        {/* quest grid */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <CardSkel key={i} className="h-40" />
          ))}
        </div>
      </div>
    </PageSkeleton>
  );
}

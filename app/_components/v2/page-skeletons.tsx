/**
 * v2 page-skeletons — route-level loading fallbacks for the Latest (/v2/*) pages.
 *
 * Unlike the legacy skeletons, these DO NOT draw the chrome: the /v2 layout keeps
 * V2Chrome + the bottom dock mounted around the loading fallback, so a skeleton
 * only fills the page body (matching that page's real shape, so navigation paints
 * the layout instantly instead of blanking — §10.7).
 *
 * Pure markup → Server Components. Pulse is `motion-safe` only; the whole tree is
 * one role="status" with an sr-only label so screen readers hear a single
 * "Loading…", not a wall of blocks.
 */
import type { ReactNode } from 'react';
import { Skel } from '@/app/_components/page-skeletons';

/** A framed glass-card placeholder of a given height. */
function CardSkel({ className = '' }: { className?: string }) {
  return <div className={`rounded-2xl border border-white/5 bg-white/2 motion-safe:animate-pulse ${className}`} />;
}

/** Shared body wrapper: a centered column at `maxW`, announced once to AT. */
function Body({ label, maxW, children }: { label: string; maxW: string; children: ReactNode }) {
  return (
    <div role="status" aria-busy="true" className="flex flex-1 flex-col">
      <span className="sr-only">{label}</span>
      <div aria-hidden className={`mx-auto w-full ${maxW} px-4 py-6 sm:px-5`}>
        {children}
      </div>
    </div>
  );
}

/** A small pill placeholder (nav-tab / toggle). */
function Pill({ className = '' }: { className?: string }) {
  return <Skel className={`h-8 rounded-md ${className}`} />;
}

/* ============================== Portfolio ============================== */

export function V2PortfolioSkeleton() {
  return (
    <Body label="Loading your portfolio…" maxW="max-w-7xl">
      {/* account-value bento: one wide tile + five metric tiles */}
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
        <Pill className="w-60" />
        <Skel className="h-3.5 w-32" />
      </div>

      {/* position cards */}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <CardSkel key={i} className="h-60" />
        ))}
      </div>
    </Body>
  );
}

/* ============================== Analytics ============================== */

export function V2AnalyticsSkeleton() {
  return (
    <Body label="Loading analytics…" maxW="max-w-6xl">
      {/* title + subtitle */}
      <div className="mb-4 flex flex-col gap-2">
        <Skel className="h-5 w-32" />
        <Skel className="h-3.5 w-full max-w-lg" />
      </div>

      {/* toolbar tabs */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Pill key={i} className="w-20" />
        ))}
      </div>

      {/* KPI strip */}
      <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skel key={i} className="h-16 rounded-xl" />
        ))}
      </div>

      {/* hot markets (wide) + sentiment/swing (stacked) */}
      <div className="mb-3 grid gap-3 lg:h-100 lg:grid-cols-3">
        <CardSkel className="lg:col-span-2 lg:h-full" />
        <div className="flex flex-col gap-3">
          <CardSkel className="h-48 lg:h-full" />
          <CardSkel className="h-48 lg:h-full" />
        </div>
      </div>

      {/* flow tape */}
      <CardSkel className="h-64" />
    </Body>
  );
}

/* ============================== Leaderboard ============================== */

const LB_COLS = 'grid-cols-[2rem_1fr_4.5rem_4.5rem] sm:grid-cols-[2.5rem_1fr_7rem_7rem]';

export function V2LeaderboardSkeleton() {
  return (
    <Body label="Loading the leaderboard…" maxW="max-w-5xl">
      {/* header */}
      <div className="mb-5 flex items-end justify-between gap-4">
        <Skel className="h-6 w-44" />
        <Skel className="h-8 w-28 rounded-lg" />
      </div>

      {/* scope tabs */}
      <div className="mb-4 flex items-center gap-2">
        <Pill className="w-28" />
        <Pill className="w-28" />
        <Skel className="ml-auto h-7 w-7 rounded-md" />
      </div>

      {/* totals strip */}
      <div className="mb-5 grid grid-cols-3 gap-2.5 rounded-2xl border border-white/5 p-2.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl bg-white/2 p-3.5">
            <Skel className="h-3 w-16" />
            <Skel className="h-5 w-20" />
          </div>
        ))}
      </div>

      {/* sort tabs */}
      <div className="mb-3 flex items-center gap-1">
        <Pill className="w-16" />
        <Pill className="w-16" />
      </div>

      {/* podium */}
      <div className="mb-5 grid grid-cols-1 items-end gap-3 sm:grid-cols-3">
        <CardSkel className="h-44 sm:order-2" />
        <CardSkel className="h-40 sm:order-1" />
        <CardSkel className="h-40 sm:order-3" />
      </div>

      {/* table */}
      <div className="overflow-hidden rounded-2xl border border-white/5">
        <div className={`grid ${LB_COLS} items-center gap-2 border-b border-white/5 px-4 py-3`}>
          <Skel className="h-3 w-4" />
          <Skel className="h-3 w-24" />
          <Skel className="ml-auto h-3 w-12" />
          <Skel className="ml-auto h-3 w-12" />
        </div>
        {Array.from({ length: 8 }).map((_, i) => (
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
    </Body>
  );
}

/* ================================= Vault ================================= */

export function V2VaultSkeleton() {
  return (
    <Body label="Loading the vault…" maxW="max-w-5xl">
      {/* header */}
      <div className="mb-5 flex flex-col gap-2">
        <Skel className="h-3 w-24" />
        <Skel className="h-6 w-48" />
        <Skel className="h-3.5 w-full max-w-lg" />
      </div>

      {/* overview + queue | supply panel */}
      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex flex-col gap-5">
          <div className="flex flex-col gap-4 rounded-2xl border border-white/5 p-5">
            <Skel className="h-4 w-32" />
            <Skel className="h-8 w-44" />
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skel key={i} className="h-12 rounded-lg" />
              ))}
            </div>
          </div>
          <CardSkel className="h-40" />
        </div>
        <div className="flex flex-col gap-4 rounded-2xl border border-white/5 p-4">
          <Skel className="h-3 w-28" />
          <Skel className="h-11 rounded-lg" />
          <Skel className="h-12 rounded-lg" />
          <div className="grid grid-cols-2 gap-2.5">
            <Skel className="h-14 rounded-xl" />
            <Skel className="h-14 rounded-xl" />
          </div>
        </div>
      </div>
    </Body>
  );
}

/* =============================== Vault Risk =============================== */

export function V2RiskSkeleton() {
  return (
    <Body label="Loading vault risk…" maxW="max-w-5xl">
      <div className="mb-5 flex flex-col gap-2">
        <Skel className="h-6 w-40" />
        <Skel className="h-3.5 w-full max-w-lg" />
      </div>

      {/* headline metric + gauges */}
      <div className="mb-5 flex flex-col gap-4 rounded-2xl border border-white/5 p-5">
        <Skel className="h-4 w-32" />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skel key={i} className="h-24 rounded-xl" />
          ))}
        </div>
      </div>

      {/* perf chart */}
      <CardSkel className="mb-5 h-56" />

      {/* stress / exposure grid */}
      <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {Array.from({ length: 2 }).map((_, i) => (
          <CardSkel key={i} className="h-52" />
        ))}
      </div>
    </Body>
  );
}

/* ============================== Degen Arena ============================== */

export function V2ArenaSkeleton() {
  return (
    <Body label="Loading Degen Arena…" maxW="max-w-6xl">
      {/* signal row */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <Skel className="h-5 w-36" />
        <Skel className="h-6 w-24 rounded-full" />
      </div>

      {/* bento header: hero (spans two rows) + four tiles */}
      <div className="grid gap-3 lg:grid-cols-[1.5fr_1fr_1fr] lg:grid-rows-2">
        <CardSkel className="min-h-[228px] sm:min-h-[268px] lg:col-start-1 lg:row-span-2" />
        <CardSkel className="h-28 lg:col-start-2 lg:row-start-1" />
        <CardSkel className="h-28 lg:col-start-3 lg:row-start-1" />
        <CardSkel className="h-28 lg:col-start-2 lg:row-start-2" />
        <CardSkel className="h-28 lg:col-start-3 lg:row-start-2" />
      </div>

      {/* stat strip */}
      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skel key={i} className="h-16 rounded-xl" />
        ))}
      </div>

      {/* toolbar + table */}
      <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:items-center">
        <Skel className="h-10 flex-1 rounded-lg" />
        <div className="flex gap-2">
          <Skel className="h-10 w-32 rounded-lg" />
          <Skel className="h-10 w-36 rounded-lg" />
        </div>
      </div>
      <div className="mt-2 overflow-hidden rounded-2xl border border-white/5">
        <div className="border-b border-white/5 px-4 py-2.5">
          <Skel className="h-3 w-40" />
        </div>
        {Array.from({ length: 7 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-4 py-3.5">
            <Skel className="h-6 w-6 rounded-md" />
            <Skel className="h-8 w-8 rounded-xl" />
            <Skel className="h-4 w-40" />
            <Skel className="ml-auto h-4 w-16" />
            <Skel className="h-4 w-16" />
          </div>
        ))}
      </div>
    </Body>
  );
}

/* ================================ Quests ================================ */

export function V2QuestsSkeleton() {
  return (
    <Body label="Loading quests…" maxW="max-w-5xl">
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
    </Body>
  );
}

/* ============================ Trader profile ============================ */

export function V2TraderSkeleton() {
  return (
    <Body label="Loading trader profile…" maxW="max-w-3xl">
      <Skel className="mb-4 h-3.5 w-28" />
      {/* identity */}
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
      {/* standing bento */}
      <div className="mb-6 grid grid-cols-3 gap-2.5 rounded-2xl border border-white/5 p-2.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex flex-col gap-2 rounded-xl bg-white/2 p-3">
            <Skel className="h-3 w-16" />
            <Skel className="h-5 w-20" />
          </div>
        ))}
      </div>
      {/* trading-style card */}
      <CardSkel className="mb-6 h-32" />
      {/* positions */}
      <div className="mb-3 flex items-center justify-between gap-2">
        <Skel className="h-4 w-32" />
        <Skel className="h-3.5 w-40" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 3 }).map((_, i) => (
          <Skel key={i} className="h-14 rounded-lg" />
        ))}
      </div>
    </Body>
  );
}

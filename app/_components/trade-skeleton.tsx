/**
 * TradeSkeleton — the route-level loading fallback for the trade page. Mirrors
 * the real terminal layout 1:1 (top chrome, 3-D surface hero, market-picker
 * rows, right-rail ticket / odds) so the shell paints instantly and there's no
 * layout shift when the live snapshot swaps in — a designed skeleton, not a
 * blanking spinner (§10.7). Shares the chrome + Skel primitive with the other
 * page skeletons. Pure markup → renders as a Server Component.
 */
import { Skel, ChromeSkeleton } from './page-skeletons';

export function TradeSkeleton() {
  return (
    <div className="flex min-h-screen flex-col" role="status" aria-busy="true">
      <span className="sr-only">Loading the trade terminal…</span>
      <ChromeSkeleton />

      {/* Main grid — same columns/hairlines as the live page. */}
      <main
        aria-hidden
        className="grid flex-1 grid-cols-1 gap-px bg-white/6 lg:grid-cols-[minmax(0,1fr)_340px] xl:grid-cols-[minmax(0,1fr)_380px] 2xl:grid-cols-[minmax(0,1fr)_420px]"
      >
        <section className="flex min-w-0 flex-col gap-px bg-white/6">
          {/* Surface hero — the horizon-glow stand-in matches SurfaceSkeleton. */}
          <div className="relative h-[48vh] min-h-90 overflow-hidden bg-bg-0 md:h-[56vh] lg:h-[64vh] lg:min-h-130">
            <div className="absolute inset-x-0 bottom-1/4 top-1/4 bg-[radial-gradient(60%_80%_at_50%_60%,rgba(45,130,150,0.18),transparent_72%)] motion-safe:animate-pulse" />
            <Skel className="absolute right-5 top-5 h-4 w-24" />
            <Skel className="absolute left-5 top-1/2 h-40 w-1.5 -translate-y-1/2 rounded-full" />
            <Skel className="absolute bottom-5 left-1/2 h-12 w-72 max-w-[calc(100%-2rem)] -translate-x-1/2 rounded-xl" />
          </div>

          {/* Market picker — a header row + table rows. */}
          <div className="flex min-h-0 flex-1 flex-col gap-3 bg-bg-0 p-4 sm:p-5">
            <div className="flex items-center justify-between">
              <Skel className="h-4 w-32" />
              <Skel className="h-7 w-28 rounded-lg" />
            </div>
            <div className="flex flex-col gap-2.5">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-4 rounded-lg border border-white/4 p-3">
                  <Skel className="h-4 w-20" />
                  <Skel className="h-4 w-16" />
                  <Skel className="ml-auto h-4 w-14" />
                  <Skel className="h-4 w-12" />
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* Right rail — ticket (desktop) + odds panel. */}
        <aside className="flex min-w-0 flex-col gap-6 bg-bg-0 p-4 sm:p-5">
          <div className="hidden flex-col gap-3 lg:flex">
            <Skel className="h-4 w-40" />
            <div className="flex flex-col gap-3 rounded-xl border border-white/5 p-4">
              <div className="grid grid-cols-2 gap-2">
                <Skel className="h-9 rounded-lg" />
                <Skel className="h-9 rounded-lg" />
              </div>
              <Skel className="h-10 rounded-lg" />
              <Skel className="h-12 rounded-xl" />
            </div>
          </div>

          <div className="flex flex-col gap-3 lg:border-t lg:border-line lg:pt-5">
            <div className="flex items-center justify-between">
              <Skel className="h-4 w-44" />
              <Skel className="h-3 w-10" />
            </div>
            <Skel className="h-40 rounded-xl" />
          </div>
        </aside>
      </main>
    </div>
  );
}

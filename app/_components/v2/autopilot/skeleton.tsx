/**
 * The Autopilot landing, as a skeleton.
 *
 * Shown twice on the way in: by the route's loading.tsx while the server fetches the
 * market snapshot and warms the pricers (a hard refresh spends a second or two there
 * with nothing else to paint), and by the panel itself until the persisted run and
 * results have been read back from the browser. Both are the same shape as the real
 * page (header, four stat tiles, Command Center beside the Plan, Performance overview
 * beside Recent runs), so the layout lands once and fills in, rather than blanking and
 * then jumping. No hooks, so it renders on the server too.
 */

function Sk({ className }: { className: string }) {
  return <div className={`skeleton rounded-md ${className}`} aria-hidden />;
}

/** A pill-shaped block, for buttons and status pills. */
function Pill({ className }: { className: string }) {
  return <div className={`skeleton rounded-xl ${className}`} aria-hidden />;
}

function TileSk() {
  return (
    <div className="glass-card flex min-w-0 flex-col gap-2.5 p-4">
      <Sk className="h-2.5 w-20" />
      <Sk className="h-[22px] w-28" />
      <Sk className="h-2.5 w-24" />
    </div>
  );
}

function PlanStepSk({ short = false }: { short?: boolean }) {
  return (
    <li className="flex gap-3 pb-3.5 last:pb-0">
      <div className="skeleton h-9 w-9 flex-none rounded-full" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-2 pt-1.5">
        <Sk className={`h-3 ${short ? 'w-24' : 'w-32'}`} />
        <Sk className="h-2.5 w-[88%]" />
      </div>
    </li>
  );
}

export function AutopilotSkeleton() {
  return (
    <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6" role="status" aria-busy="true" aria-label="Loading Autopilot">
      {/* Page header: name, purpose line, status pill; the two actions on the right. */}
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <Sk className="h-7 w-36" />
          <div className="mt-3 flex flex-wrap items-center gap-2.5">
            <Sk className="h-3 w-56" />
            <Pill className="h-5 w-16 rounded-full" />
          </div>
        </div>
        <div className="flex items-center gap-2.5">
          <Pill className="h-10 w-24" />
          <Pill className="h-10 w-32" />
        </div>
      </header>

      {/* Stat tiles */}
      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <TileSk />
        <TileSk />
        <TileSk />
        <TileSk />
      </div>

      {/* Command Center beside the Plan */}
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.08fr)_minmax(0,1fr)]">
        <section className="glass-card flex min-w-0 flex-col gap-3 p-4">
          <Sk className="h-2.5 w-28" />
          <div className="grid grid-cols-2 gap-1.5 rounded-xl bg-white/4 p-1">
            <Pill className="h-12" />
            <Pill className="h-12 opacity-50" />
          </div>
          {/* Kelly's chat well: title bar, a couple of bubbles, the composer. */}
          <div className="flex flex-col overflow-hidden rounded-xl border border-line bg-black/20">
            <div className="flex items-center gap-2.5 border-b border-white/6 px-3 py-2">
              <div className="skeleton h-7 w-7 rounded-full" aria-hidden />
              <div className="flex flex-col gap-1.5">
                <Sk className="h-2.5 w-10" />
                <Sk className="h-2 w-20" />
              </div>
              <Pill className="ml-auto h-7 w-20" />
            </div>
            <div className="flex h-36 flex-col gap-2 px-3 py-3">
              <Sk className="h-9 w-[78%] rounded-2xl" />
              <Sk className="ml-auto h-7 w-[46%] rounded-2xl" />
            </div>
            <div className="flex items-center gap-2 border-t border-white/6 px-3 py-2.5">
              <Sk className="h-4 flex-1" />
              <Pill className="h-9 w-9" />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Pill className="h-7 w-24 rounded-full" />
            <Pill className="h-7 w-24 rounded-full" />
            <Pill className="h-7 w-28 rounded-full" />
            <Pill className="h-7 w-20 rounded-full" />
          </div>
        </section>

        <section className="glass-card flex min-w-0 flex-col p-4">
          <div className="flex items-center justify-between">
            <Sk className="h-2.5 w-16" />
            <Pill className="h-5 w-20 rounded-full" />
          </div>
          <Sk className="mt-3 h-3.5 w-[92%]" />
          <Sk className="mt-2 h-3.5 w-[70%]" />
          <ol className="mt-4 flex flex-1 flex-col">
            <PlanStepSk />
            <PlanStepSk short />
            <PlanStepSk />
            <PlanStepSk short />
          </ol>
          <div className="mt-auto border-t border-white/6 pt-3">
            <Sk className="h-2.5 w-44" />
          </div>
        </section>
      </div>

      {/* Performance overview beside Recent runs */}
      <div className="mb-4 grid gap-4 lg:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <section className="glass-card flex min-w-0 flex-col p-4">
          <div className="flex items-center justify-between">
            <Sk className="h-2.5 w-36" />
            <Pill className="h-7 w-40 rounded-lg" />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-x-4 gap-y-3 sm:grid-cols-5">
            {[0, 1, 2, 3, 4].map((i) => (
              <div key={i} className="flex flex-col gap-2">
                <Sk className="h-2 w-14" />
                <Sk className="h-[15px] w-16" />
              </div>
            ))}
          </div>
          <Sk className="mt-5 h-44 w-full rounded-lg" />
          <div className="mt-2 flex justify-between">
            {[0, 1, 2, 3, 4, 5, 6].map((i) => (
              <Sk key={i} className="h-2 w-8" />
            ))}
          </div>
        </section>

        <section className="glass-card flex min-w-0 flex-col p-4">
          <Sk className="h-2.5 w-24" />
          <ul className="rows-divided mt-3 flex flex-col">
            {[0, 1, 2].map((i) => (
              <li key={i} className="flex items-center gap-3 py-3">
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Sk className="h-3 w-28" />
                  <Sk className="h-2.5 w-40" />
                </div>
                <Sk className="h-3.5 w-16" />
              </li>
            ))}
          </ul>
          <Pill className="mt-4 h-9 w-full" />
        </section>
      </div>
    </div>
  );
}

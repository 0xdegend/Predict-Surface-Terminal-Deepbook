'use client';

/**
 * SimpleSkeleton — what the screen looks like before it has anything to say.
 *
 * Shaped like the real layout, not like a spinner: the headline, the cadence tabs, the
 * chart card beside the ticket rail, the round cards, the results tape. When the data
 * lands, blocks fill in where blocks already were, so nothing jumps and the page never
 * changes size under the reader. A centred spinner on an empty page would reflow the
 * whole screen the moment it resolved.
 *
 * Only ever shown for the FIRST paint of a cold load, where the price backfill takes a
 * few seconds. A round rolling over does NOT come back through here — the page stays
 * mounted and only the hero swaps, which is the whole point of keeping this separate
 * from the live layout. See [[simple-mode]].
 */

/** A shimmering block. `className` carries the size, so callers shape the layout. */
function Block({ className }: { className: string }) {
  return <span className={`skeleton block rounded-md ${className}`} />;
}

export function SimpleSkeleton() {
  return (
    <main aria-busy="true" aria-label="Loading the round" className="mx-auto flex w-full max-w-5xl flex-1 flex-col px-3 py-4 sm:px-5">
      {/* headline + cadence tabs */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <Block className="h-5 w-56 sm:w-72" />
          <Block className="h-6 w-24 rounded-md sm:w-28" />
        </div>
        <div className="flex w-full shrink-0 gap-1 rounded-xl border border-(--line-soft) bg-bg-1 p-1 sm:w-auto">
          {[0, 1, 2].map((i) => (
            <Block key={i} className="h-7 flex-1 sm:w-16 sm:flex-none" />
          ))}
        </div>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_340px]">
        {/* chart card */}
        <section className="panel flex min-h-0 flex-col overflow-hidden">
          <div className="flex items-start justify-between gap-4 px-4 pb-3 pt-4">
            <div className="flex flex-col gap-2">
              <Block className="h-2.5 w-20" />
              <Block className="h-8 w-48 sm:h-9 sm:w-56" />
              <Block className="h-3 w-32" />
            </div>
            <div className="flex flex-col items-end gap-2">
              <Block className="h-2.5 w-24" />
              <Block className="h-7 w-20 sm:h-8 sm:w-24" />
              <Block className="h-2.5 w-10" />
            </div>
          </div>
          <div className="min-h-0 flex-1 px-3 pb-3">
            <Block className="h-full min-h-55 w-full rounded-xl lg:min-h-90" />
          </div>
          {/* the mobile UP / DOWN pair lives on the chart */}
          <div className="grid grid-cols-2 gap-2 px-3 pb-3 lg:hidden">
            <Block className="h-12 rounded-xl" />
            <Block className="h-12 rounded-xl" />
          </div>
        </section>

        {/* ticket rail (desktop) */}
        <aside className="panel hidden flex-col gap-4 p-4 lg:flex">
          <div className="flex flex-col gap-2">
            <Block className="h-2.5 w-28" />
            <Block className="h-6 w-36" />
            <Block className="h-3 w-full" />
          </div>
          <hr className="border-(--line-soft)" />
          <div className="flex flex-col gap-2">
            <Block className="h-2.5 w-24" />
            <div className="flex gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <Block key={i} className="h-8 flex-1 rounded-lg" />
              ))}
            </div>
            <Block className="h-9 w-full rounded-lg" />
          </div>
          <Block className="mt-auto h-12 w-full rounded-lg" />
          <div className="grid grid-cols-2 gap-2">
            <Block className="h-11 rounded-xl" />
            <Block className="h-11 rounded-xl" />
          </div>
        </aside>
      </div>

      {/* other rounds */}
      <section className="mt-5">
        <Block className="mb-3 h-3.5 w-40" />
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((i) => (
            <Block key={i} className="h-52 rounded-[10px]" />
          ))}
        </div>
      </section>

      {/* results tape */}
      <section className="panel mt-5 flex flex-col gap-2.5 px-4 py-3.5">
        <Block className="h-3.5 w-52" />
        <Block className="h-7 w-full rounded-lg" />
      </section>
    </main>
  );
}

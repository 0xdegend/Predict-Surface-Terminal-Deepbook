/**
 * KellyHubSkeleton — the hub's shape while the live snapshot loads.
 *
 * Route-level loading UI for /v2/kelly, and the first paint the client shows before
 * hydration. It draws the tab bar and the chat tab's two columns (the default tab), so
 * the page settles in place instead of jumping when the real screen lands. No hooks:
 * safe on the server.
 */
export function KellyHubSkeleton() {
  return (
    <div role="status" aria-busy="true" aria-label="Loading Kelly" className="flex min-h-0 flex-1 flex-col">
      {/* Tab bar */}
      <div className="border-b border-line">
        <div className="flex h-11 items-center gap-3 px-3 sm:px-5">
          <span className="skeleton h-[22px] w-[22px] rounded-full" />
          <span className="skeleton h-3.5 w-12 rounded" />
          <span className="mx-1 h-4 w-px bg-white/10" />
          <span className="skeleton h-7 w-[236px] rounded-lg" />
        </div>
      </div>
      {/* Chat tab: stage beside the conversation rail */}
      <div className="grid flex-1 grid-cols-1 gap-px bg-white/6 lg:grid-cols-[minmax(0,1fr)_400px]">
        <div className="hidden min-w-0 flex-col bg-bg-0 lg:flex">
          <div className="flex h-12 items-center gap-2 border-b border-line px-4">
            <span className="skeleton h-5 w-28 rounded" />
            <span className="skeleton h-6 w-20 rounded-lg" />
            <span className="skeleton h-6 w-20 rounded-lg" />
            <span className="skeleton h-6 w-24 rounded-lg" />
            <span className="skeleton ml-auto h-4 w-24 rounded" />
          </div>
          <div className="skeleton m-4 h-[54vh] min-h-90 rounded-xl" />
          <div className="mx-4 flex flex-col gap-2">
            <span className="skeleton h-9 rounded-lg" />
            <span className="skeleton h-9 rounded-lg" />
            <span className="skeleton h-9 rounded-lg" />
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-3 bg-bg-0 p-4">
          <div className="flex items-center gap-3">
            <span className="skeleton h-10 w-10 rounded-full" />
            <div className="flex flex-col gap-1.5">
              <span className="skeleton h-3.5 w-16 rounded" />
              <span className="skeleton h-2.5 w-44 rounded" />
            </div>
          </div>
          <span className="skeleton h-28 rounded-xl" />
          <span className="skeleton h-24 rounded-xl" />
          <span className="skeleton mt-auto h-11 rounded-xl" />
        </div>
      </div>
    </div>
  );
}

/**
 * /v2/leaderboard — Season 2 standings for the new deployment.
 *
 * Live standings need an aggregated leaderboard endpoint the beta indexer doesn't
 * expose yet, so this is the Season-2 shell: fresh-start framing + a link to the
 * archived Season-1 board. It fills in automatically once the endpoint ships.
 */
import Link from 'next/link';

export const dynamic = 'force-dynamic';

export default function V2LeaderboardPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="eyebrow mb-1">Latest · Season 2</p>
        <h1 className="text-[22px] font-semibold tracking-tight text-text-1">Leaderboard</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
          The new deployment starts everyone fresh. Trade to climb the Season-2 board.
        </p>
      </header>

      <div className="panel flex flex-col items-center gap-3 px-4 py-10 text-center">
        <span className="eyebrow">Season 2 · live</span>
        <p className="max-w-md text-[13px] leading-relaxed text-text-2">
          Standings appear here as trades are indexed on the new release. Be among the first names
          on the board.
        </p>
        <div className="mt-1 flex flex-wrap items-center justify-center gap-3">
          <Link
            href="/v2"
            className="rounded-lg bg-(--accent-soft) px-4 py-2 text-[13px] font-semibold text-up transition-shadow hover:shadow-[0_0_22px_-6px_var(--accent-glow)]"
          >
            Start trading
          </Link>
          <Link href="/season-1" className="text-[12px] text-text-3 hover:text-text-1">
            View Season 1 archive →
          </Link>
        </div>
      </div>
    </main>
  );
}

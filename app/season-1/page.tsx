/**
 * /season-1 — the archived Season-1 leaderboard from the LEGACY deployment.
 *
 * Reads data/legacy-season1.json (produced by scripts/snapshot-legacy.mjs) and
 * reuses the live leaderboard aggregator to render the final standings. Migration
 * decision: legacy standings can't carry to the new packages, so we archive them
 * here and the new deployment starts fresh as "Season 2". If the archive file
 * isn't present yet, this guides you to run the snapshot.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import Link from 'next/link';
import { aggregateLeaderboard, sortRows } from '@/lib/leaderboard/aggregate';
import { wallClockMs } from '@/lib/markets/v2-discovery';
import type { PositionMintedEvent, PositionRedeemedEvent, ManagerRow } from '@/lib/api/types';
import { shortId } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface Archive {
  meta?: { capturedAt?: string; counts?: Record<string, number> };
  managers?: ManagerRow[];
  positionsMinted?: PositionMintedEvent[];
  positionsRedeemed?: PositionRedeemedEvent[];
}

async function loadArchive(): Promise<Archive | null> {
  try {
    const raw = await readFile(join(process.cwd(), 'data/legacy-season1.json'), 'utf8');
    return JSON.parse(raw) as Archive;
  } catch {
    return null;
  }
}

export default async function Season1Page() {
  const archive = await loadArchive();

  return (
    <main className="mx-auto max-w-3xl px-4 py-8 sm:px-6">
      <header className="mb-6">
        <p className="eyebrow mb-1">Archived · Season 1</p>
        <h1 className="text-[22px] font-semibold tracking-tight text-text-1">Season 1 leaderboard</h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-relaxed text-text-2">
          Final standings from the original Skew deployment. These can’t carry to the new
          on-chain packages, so they’re preserved here — the new release starts everyone fresh
          as <span className="text-text-1">Season 2</span>.
        </p>
      </header>

      {!archive ? (
        <div className="card px-4 py-6 text-[13px] leading-relaxed text-text-2">
          No archive found yet. Capture it before the old server winds down:
          <pre className="mt-2 rounded-md bg-white/5 px-3 py-2 font-mono text-[11px] text-text-3">node scripts/snapshot-legacy.mjs</pre>
        </div>
      ) : (
        <Standings archive={archive} />
      )}

      <div className="mt-6 text-[12px]">
        <Link href="/v2" className="text-text-3 hover:text-text-1">Latest deployment →</Link>
      </div>
    </main>
  );
}

function Standings({ archive }: { archive: Archive }) {
  const capturedAt = archive.meta?.capturedAt ? new Date(archive.meta.capturedAt) : null;
  const rows = sortRows(
    aggregateLeaderboard(
      archive.positionsMinted ?? [],
      archive.positionsRedeemed ?? [],
      archive.managers ?? [],
      capturedAt?.getTime() ?? wallClockMs(),
    ),
    'volume',
  ).slice(0, 25);

  return (
    <div className="panel p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <span className="eyebrow">Top 25 by volume</span>
        {capturedAt && (
          <span className="font-mono text-[11px] text-text-3">
            captured {capturedAt.toISOString().slice(0, 10)}
          </span>
        )}
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="head-divider text-text-3 [&>th]:pb-2 [&>th]:font-normal">
            <th className="text-left">#</th>
            <th className="text-left">Trader</th>
            <th className="text-right">Volume</th>
            <th className="text-right">Trades</th>
          </tr>
        </thead>
        <tbody className="rows-divided">
          {rows.map((r, i) => (
            <tr key={r.owner} className="[&>td]:py-1.5">
              <td className="text-left font-mono text-text-3">{i + 1}</td>
              <td className="text-left font-mono text-text-2">{shortId(r.owner)}</td>
              <td className="text-right font-mono tabular-nums text-text-1">
                ${r.volume.toLocaleString(undefined, { maximumFractionDigits: 0 })}
              </td>
              <td className="text-right font-mono tabular-nums text-text-2">{r.trades}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-[10px] leading-relaxed text-text-3">
        Ranked by total minted volume across {archive.meta?.counts?.positionsMinted ?? 0} archived trades.
      </p>
    </div>
  );
}

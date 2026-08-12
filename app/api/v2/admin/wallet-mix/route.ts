/**
 * GET /api/v2/admin/wallet-mix — the admin wallet-mix summary.
 *
 * Joins the tracked sign-in categories (lib/server/wallet-track-store) with the set
 * of wallets that have actually TRADED (the leaderboard tally), so the admin sees both
 * how people connect (Google vs Slush vs Other) AND how each converts to a real bet.
 * Returns COUNTS ONLY — never the per-address map — so no wallet→provider list leaves
 * the server. The traded set comes from the same on-chain tally the boards use, so it
 * needs no extra client instrumentation and covers wallets that traded before this
 * shipped. Degrades gracefully: a board hiccup just zeroes the traded column.
 */
import { NextResponse } from 'next/server';
import { listWalletMixSince } from '@/lib/server/wallet-track-store';
import { getLeaderboardBoards } from '@/lib/leaderboard/v2-indexer';
import { LEGACY_OWNERS } from '@/lib/leaderboard/legacy-carryover';
import { WALLET_KINDS, type WalletKind } from '@/lib/wallet-kind';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;
/** ?range= filters by when a wallet FIRST connected. 'all' = no floor. */
const RANGE_DAYS: Record<string, number> = { '1d': 1, '7d': 7, '14d': 14 };

interface KindCount {
  connected: number;
  traded: number;
}
type WalletMixSummary = {
  range: string;
  kinds: Record<WalletKind, KindCount>;
  totalConnected: number;
  totalTraded: number;
  builtAtMs: number;
};

export async function GET(req: Request) {
  const rangeParam = new URL(req.url).searchParams.get('range') ?? 'all';
  const range = rangeParam in RANGE_DAYS ? rangeParam : 'all';
  const sinceMs = range === 'all' ? 0 : Date.now() - RANGE_DAYS[range] * DAY_MS;

  const members = await listWalletMixSince(sinceMs).catch(() => null);
  if (!members) {
    // No store configured / read failed — return an empty-but-valid shape.
    const empty = Object.fromEntries(WALLET_KINDS.map((k) => [k, { connected: 0, traded: 0 }])) as Record<WalletKind, KindCount>;
    return NextResponse.json({ range, kinds: empty, totalConnected: 0, totalTraded: 0, builtAtMs: Date.now() } satisfies WalletMixSummary, {
      headers: { 'cache-control': 'no-store' },
    });
  }

  // The set of wallets that have placed at least one bet. Season-1 carryover traders
  // are seeded directly (they traded then, and the leaderboard route overlays them the
  // same way), so a returning carryover wallet counts as "traded" here too — matching
  // the panel's own "Traders" figure.
  const tradedSet = new Set<string>(LEGACY_OWNERS.map((o) => o.toLowerCase()));
  let builtAtMs = Date.now();
  try {
    const boards = await getLeaderboardBoards();
    builtAtMs = boards.builtAtMs;
    for (const r of [...boards.all, ...boards.skew]) {
      if ((r.trades ?? 0) > 0) tradedSet.add(r.owner.toLowerCase());
    }
  } catch {
    // Board unavailable → keep just the carryover traders; the live column reads low.
  }

  let totalConnected = 0;
  let totalTraded = 0;
  const kinds = Object.fromEntries(
    WALLET_KINDS.map((k) => {
      const addrs = members[k] ?? [];
      const traded = addrs.reduce((n, a) => n + (tradedSet.has(a) ? 1 : 0), 0);
      totalConnected += addrs.length;
      totalTraded += traded;
      return [k, { connected: addrs.length, traded }];
    }),
  ) as Record<WalletKind, KindCount>;

  return NextResponse.json({ range, kinds, totalConnected, totalTraded, builtAtMs } satisfies WalletMixSummary, {
    headers: { 'cache-control': 'public, s-maxage=30, stale-while-revalidate=120' },
  });
}

/**
 * lib/leaderboard/v2.ts — Season-2 standings rows for the NEW deployment.
 *
 * The beta indexer has no per-owner aggregation endpoint yet (requested — see
 * the endpoint wishlist sent to DeepBook eng), so the board renders
 * clearly-marked SAMPLE rows until it ships. The row shape below is what the
 * future hook should emit; when real rows arrive they take over automatically
 * (or flip `V2_LEADERBOARD_DEMO_ENABLED` off).
 */

export const V2_LEADERBOARD_DEMO_ENABLED = true;

export type V2SortKey = 'points' | 'volume';

/** One trader's standing — flat shape, ready for a real aggregation endpoint. */
export interface V2LeaderboardRow {
  owner: string;
  points: number;
  /** Lifetime DUSDC premium staked this season. */
  volume: number;
  trades: number;
  /** True for illustrative rows — no explorer/profile links, banner shown. */
  sample?: boolean;
}

export function sortV2Rows(rows: V2LeaderboardRow[], key: V2SortKey): V2LeaderboardRow[] {
  return [...rows].sort((a, b) => (key === 'volume' ? b.volume - a.volume : b.points - a.points));
}

export function v2LeaderboardTotals(rows: V2LeaderboardRow[]): {
  traders: number;
  volume: number;
  trades: number;
} {
  return {
    traders: rows.length,
    volume: rows.reduce((s, r) => s + r.volume, 0),
    trades: rows.reduce((s, r) => s + r.trades, 0),
  };
}

/* ───────────────────────────── sample rows ───────────────────────────── */

/** Deterministic illustrative addresses (not real accounts). */
const A = (tail: string) => `0x${tail.padStart(64, tail[0] ?? '0')}`;

/** Volumes deliberately don't track points 1:1 so the sort tabs visibly reorder. */
export function demoLeaderboardRows(): V2LeaderboardRow[] {
  const rows: [string, number, number, number][] = [
    // [addr tail, points, volume, trades]
    ['7e42a9c15b8d03f6', 12_840, 18_460, 214],
    ['3ba8d51f92c470e6', 11_120, 24_930, 178],
    ['9f04c72ae61b53d8', 9_875, 9_310, 262],
    ['5c17e93bd042f8a6', 8_240, 15_780, 96],
    ['d26b40f79e83c1a5', 7_610, 6_240, 143],
    ['81f5da3c67042be9', 6_980, 11_050, 88],
    ['4a93cb08e5d17f26', 5_430, 13_670, 71],
    ['b70e614d29f8a3c5', 4_720, 3_890, 122],
    ['2d5f98a1c4e7b306', 3_910, 7_460, 54],
    ['e648b2d90a17c3f5', 3_240, 2_310, 67],
    ['6c01f7b3d8e429a5', 2_150, 4_820, 31],
    ['a35d80c1f96e24b7', 1_480, 1_270, 26],
  ];
  return rows.map(([tail, points, volume, trades]) => ({
    owner: A(tail),
    points,
    volume,
    trades,
    sample: true,
  }));
}

import { it, expect } from 'vitest';
import { getLeaderboardBoards } from './v2-indexer';
import { mergeLegacyCarryover } from './legacy-carryover';

const WALLET = '0x22cc7ef79881b98152d9a7c2a50fefe42a468434ddff07e14b08562774a1940f';
const has = (rows: { owner: string }[]) =>
  rows.findIndex((r) => r.owner?.toLowerCase() === WALLET.toLowerCase());

it('wallet now appears on the GENERAL board via the indexer', { timeout: 180_000 }, async () => {
  const boards = await getLeaderboardBoards();
  const skew = mergeLegacyCarryover(boards.skew); // route applies this
  const ai = has(boards.all);
  const si = has(skew);
  console.log('ALL rows', boards.all.length, '| wallet rank on ALL:', ai < 0 ? 'MISSING' : `${ai + 1}/${boards.all.length}`);
  if (ai >= 0) console.log('  ALL row:', JSON.stringify(boards.all[ai]));
  console.log('SKEW rows', skew.length, '| wallet rank on SKEW:', si < 0 ? 'MISSING' : `${si + 1}/${skew.length}`);
  console.log('ALL top 3:', boards.all.slice(0, 3).map((r) => `${r.owner.slice(0, 8)}…=${r.points.toFixed(1)}pts/${r.trades}t`).join('  '));
  expect(ai).toBeGreaterThanOrEqual(0); // wallet must be on the general board
});

import { describe, it, expect } from 'vitest';
import { mergeFaucetParticipants, FAUCET_PARTICIPANT_POINTS } from './faucet-participants';
import type { V2LeaderboardRow } from './v2';

const trader = (owner: string, points: number, trades = 5): V2LeaderboardRow => ({
  owner,
  points,
  volume: points * 2,
  trades,
  viaSkew: true,
});

describe('mergeFaucetParticipants', () => {
  it('returns the board untouched when there are no claimers', () => {
    const board = [trader('0xAA', 100)];
    expect(mergeFaucetParticipants(board, [])).toEqual(board);
  });

  it('adds a claimer who has not traded as a 0-trade Starter row (lowercased)', () => {
    const out = mergeFaucetParticipants([trader('0xaa', 100)], ['0xBB']);
    const bb = out.find((r) => r.owner === '0xbb');
    expect(bb).toMatchObject({
      owner: '0xbb', // new faucet rows are stored lowercased
      points: FAUCET_PARTICIPANT_POINTS,
      volume: 0,
      trades: 0,
      viaFaucet: true,
      viaSkew: true,
    });
  });

  it('only flags an existing trader who also claimed — never inflates their stats', () => {
    // Claimer passed in a different case than the trader row: still matches, no dupe.
    const out = mergeFaucetParticipants([trader('0xaa', 100, 7)], ['0xAA']);
    const aa = out.find((r) => r.owner === '0xaa')!;
    expect(aa.points).toBe(100); // unchanged, no participation point added
    expect(aa.trades).toBe(7);
    expect(aa.volume).toBe(200);
    expect(aa.viaFaucet).toBe(true);
    expect(out).toHaveLength(1); // no duplicate row
  });

  it('matches case-insensitively and dedupes repeated claimers', () => {
    const out = mergeFaucetParticipants([trader('0xaabb', 50)], ['0xAABB', '0xaabb', '0xCC']);
    expect(out.filter((r) => r.owner === '0xaabb')).toHaveLength(1);
    expect(out.find((r) => r.owner === '0xaabb')!.viaFaucet).toBe(true);
    expect(out.filter((r) => r.owner === '0xcc')).toHaveLength(1); // the one genuinely-new claimer
  });

  it('keeps real traders ranked above Starter-only rows (sorted by points desc)', () => {
    const out = mergeFaucetParticipants([trader('0xaa', 100), trader('0xbb', 40)], ['0xcc', '0xdd']);
    expect(out.map((r) => r.owner)).toEqual(['0xaa', '0xbb', '0xcc', '0xdd']);
    // The two Starters sit at the bottom with the participation point only.
    expect(out.slice(2).every((r) => r.points === FAUCET_PARTICIPANT_POINTS && r.trades === 0)).toBe(true);
  });

  it('does not mutate the input rows', () => {
    const board = [trader('0xaa', 100)];
    const snapshot = JSON.parse(JSON.stringify(board));
    mergeFaucetParticipants(board, ['0xaa', '0xbb']);
    expect(board).toEqual(snapshot);
  });
});

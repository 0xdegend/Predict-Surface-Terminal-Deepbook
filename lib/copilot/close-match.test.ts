import { describe, it, expect } from 'vitest';
import { matchPositionsToClose, positionCloseLabel } from './close-match';
import type { V2PortfolioPosition } from '@/lib/portfolio/v2';

// Minimal closeable positions (only the fields the matcher reads).
const pos = (over: Partial<V2PortfolioPosition>): V2PortfolioPosition =>
  ({ key: 'k', direction: 'Up', qty: 10, settled: false, ...over }) as V2PortfolioPosition;

const upLive = pos({ key: 'up', direction: 'Up', strike: 65_000 });
const downLive = pos({ key: 'down', direction: 'Down', strike: 64_000 });
const upWon = pos({ key: 'won', direction: 'Up', strike: 66_000, settled: true, won: true });
const upLost = pos({ key: 'lost', direction: 'Up', strike: 67_000, settled: true, won: false });

describe('matchPositionsToClose', () => {
  it('a single closeable + no selector → close it', () => {
    expect(matchPositionsToClose([upLive], {})).toEqual({ action: 'close', positions: [upLive] });
  });

  it('multiple + no selector → ask which', () => {
    const m = matchPositionsToClose([upLive, downLive], {});
    expect(m.action).toBe('ask');
    expect(m.positions).toHaveLength(2);
  });

  it('a direction filters, then closes a unique match', () => {
    expect(matchPositionsToClose([upLive, downLive], { dir: 'down' })).toEqual({ action: 'close', positions: [downLive] });
  });

  it('a direction that still leaves several → ask', () => {
    expect(matchPositionsToClose([upLive, upWon], { dir: 'up' }).action).toBe('ask');
  });

  it('a strike matches within tolerance', () => {
    expect(matchPositionsToClose([upLive, downLive], { strike: 65_010 })).toEqual({ action: 'close', positions: [upLive] });
    expect(matchPositionsToClose([upLive, downLive], { strike: 40_000 }).action).toBe('none');
  });

  it('winnings → only settled winners, and closes them all', () => {
    const m = matchPositionsToClose([upLive, downLive, upWon, upLost], { winnings: true });
    expect(m.action).toBe('close');
    expect(m.positions).toEqual([upWon]); // not the live ones, not the loser
  });

  it('winnings with none settled → none', () => {
    expect(matchPositionsToClose([upLive, downLive], { winnings: true }).action).toBe('none');
  });

  it('"all" closes every closeable position at once', () => {
    const m = matchPositionsToClose([upLive, downLive], { all: true });
    expect(m.action).toBe('close');
    expect(m.positions).toHaveLength(2);
  });
});

describe('positionCloseLabel', () => {
  it('labels side, strike, and state', () => {
    expect(positionCloseLabel(upLive)).toMatch(/UP \$65,000 · open/);
    expect(positionCloseLabel(upWon)).toMatch(/UP \$66,000 · won, ready to redeem/);
    expect(positionCloseLabel(upLost)).toMatch(/lost, can clear/);
  });
});

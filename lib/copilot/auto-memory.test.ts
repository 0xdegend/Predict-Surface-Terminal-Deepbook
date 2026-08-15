import { describe, it, expect, beforeEach } from 'vitest';
import {
  styleNoteForBet,
  styleNoteForRange,
  claimAutoRememberSlot,
  _resetAutoRememberClaims,
} from './auto-memory';

describe('styleNoteForBet', () => {
  it('describes a safe UP lean', () => {
    expect(styleNoteForBet({ isUp: true, conviction: 'safe' })).toBe('leans UP and prefers safer bets');
  });
  it('describes a bold DOWN lean', () => {
    expect(styleNoteForBet({ isUp: false, conviction: 'bold' })).toBe(
      'leans DOWN and likes bolder, higher-payout bets',
    );
  });
  it('falls back to a plain lean for an even/unknown conviction', () => {
    expect(styleNoteForBet({ isUp: true, conviction: 'even' })).toBe('leans UP');
    expect(styleNoteForBet({ isUp: false, conviction: 'whatever' })).toBe('leans DOWN');
  });
});

describe('styleNoteForRange', () => {
  it('describes a range trader', () => {
    expect(styleNoteForRange()).toBe('likes range bets on BTC');
  });
});

describe('claimAutoRememberSlot — once per session per wallet', () => {
  beforeEach(() => _resetAutoRememberClaims());

  it('grants the first claim and denies repeats for the same wallet', () => {
    expect(claimAutoRememberSlot('0xABC')).toBe(true);
    expect(claimAutoRememberSlot('0xabc')).toBe(false); // case-insensitive
    expect(claimAutoRememberSlot('0xABC')).toBe(false);
  });

  it('tracks wallets independently', () => {
    expect(claimAutoRememberSlot('0xaaa')).toBe(true);
    expect(claimAutoRememberSlot('0xbbb')).toBe(true);
    expect(claimAutoRememberSlot('0xaaa')).toBe(false);
  });
});

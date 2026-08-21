import { describe, it, expect } from 'vitest';
import { classifyVisitor, VISITOR_KEY } from './visitor';

describe('classifyVisitor', () => {
  it('calls an empty browser new', () => {
    expect(classifyVisitor([])).toBe('new');
  });

  it('recognises a browser that carries any prior Skew state', () => {
    // Every one of these is written only after the app has actually been used.
    for (const key of [
      'skew.tour.v1',
      'skew.tour.trade.v1',
      'skew.deployment',
      'skew:session-prefs',
      'skew-autopilot',
      'kelly-dock-seen',
      'skew:surface-coach-seen',
      'predict.surfaceGuide',
    ]) {
      expect(classifyVisitor([key]), key).toBe('returning');
    }
  });

  it('does not count the dialog\'s OWN store, which would be circular', () => {
    // `skew.tradeView` is written by the very store the dialog uses to remember an
    // answer, so counting it would flip a newcomer to "returning" the moment they
    // answered — and they would then also get the returning-trader note.
    expect(classifyVisitor(['skew.tradeView'])).toBe('new');
  });

  it('does not count its own verdict key', () => {
    expect(classifyVisitor([VISITOR_KEY])).toBe('new');
  });

  it('ignores other sites sharing the origin', () => {
    expect(classifyVisitor(['theme', 'i18nextLng', 'wagmi.store', 'sui-dapp-kit:x'])).toBe('new');
  });

  it('still spots a real key among unrelated ones', () => {
    expect(classifyVisitor(['theme', 'skew.tradeView', 'skew.tour.v1'])).toBe('returning');
  });
});

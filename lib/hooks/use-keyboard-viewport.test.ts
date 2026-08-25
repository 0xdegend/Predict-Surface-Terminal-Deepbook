import { describe, it, expect } from 'vitest';
import { isKeyboardOpen } from './use-keyboard-viewport';

/* Numbers below are an iPhone 14 Pro in Safari: ~700px of layout viewport once the
   browser chrome is accounted for, and a ~336px keyboard. */
const LAYOUT = 700;

describe('isKeyboardOpen', () => {
  it('sees a real keyboard', () => {
    expect(isKeyboardOpen(LAYOUT, 364)).toBe(true); // 336px keyboard
  });

  it('ignores the URL bar collapsing', () => {
    expect(isKeyboardOpen(LAYOUT, 640)).toBe(false); // 60px of browser chrome
    expect(isKeyboardOpen(LAYOUT, LAYOUT)).toBe(false); // nothing at all
  });

  it('still sees the keyboard after Safari has panned the visible box', () => {
    // THE REGRESSION. Safari pans on focus, up to the full keyboard height, and the
    // previous rule subtracted that pan (`innerHeight - height - offsetTop`), so with
    // a 336px keyboard AND a 336px pan it computed 0 and decided the keyboard was
    // shut. The dock then stayed on screen, over the keyboard. The pan must not be an
    // input at all: only the layout-vs-visible height gap is.
    expect(isKeyboardOpen(LAYOUT, 364)).toBe(true); // pan of 336 is irrelevant
    const oldRule = (inner: number, h: number, offsetTop: number) => inner - h - offsetTop > 140;
    expect(oldRule(LAYOUT, 364, 336)).toBe(false); // what shipped, and why it broke
  });

  it('holds the line between chrome and keyboard at the documented threshold', () => {
    expect(isKeyboardOpen(LAYOUT, LAYOUT - 140)).toBe(false); // exactly 140 is not a keyboard
    expect(isKeyboardOpen(LAYOUT, LAYOUT - 141)).toBe(true);
  });
});

'use client';

/**
 * useKeyboardViewport — makes a viewport-locked mobile screen behave when the
 * on-screen keyboard opens.
 *
 * The problem: iOS Safari does NOT shrink the layout viewport (or `dvh`) when the
 * keyboard appears — it only shrinks the VISUAL viewport. So a `100dvh` bounded
 * layout stays full-height, the keyboard overlays the bottom, and a composer
 * pinned to the bottom ends up stranded above the floating dock with a big gap
 * (exactly the Ask-Kelly typing bug).
 *
 * The fix: read the real visible height from `window.visualViewport` and publish it
 * as `--kvh` on <html>, plus a `kb-open` class while a keyboard is up. Global CSS
 * (see globals.css, mobile-only) then collapses the shell to `--kvh`, drops the
 * dock clearance, hides the dock, and sizes the chat to the space above the
 * keyboard — so the composer sits right on the keyboard with no gap.
 *
 * Side-effecting only (no re-renders): it writes a CSS var + class and cleans both
 * up on unmount. Mount it once on the screen that needs it (the copilot chat).
 */
import { useEffect } from 'react';

/** Below this many px of shrink we treat it as browser-chrome collapse, not a
 *  keyboard (a real mobile keyboard is ~250-350px; the URL bar is ~60-100px). */
const KEYBOARD_MIN_PX = 140;

export function useKeyboardViewport(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return; // no VisualViewport API → leave the dvh layout as-is (fine when closed)
    const root = document.documentElement;

    const update = () => {
      // Keyboard overlap = layout viewport height − what's actually visible.
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      const open = overlap > KEYBOARD_MIN_PX;
      root.classList.toggle('kb-open', open);
      root.style.setProperty('--kvh', `${Math.round(vv.height)}px`);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.classList.remove('kb-open');
      root.style.removeProperty('--kvh');
    };
  }, []);
}

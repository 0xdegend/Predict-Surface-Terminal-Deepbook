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
    const root = document.documentElement;
    // `chat-page` locks the shell to --kvh (globals.css) so this viewport-locked
    // screen never document-scrolls — even when `100dvh` overshoots the visible
    // area (mobile browser toolbar) — leaving the thread as the only scroller.
    root.classList.add('chat-page');

    const vv = window.visualViewport;
    if (!vv) {
      // No VisualViewport API: fall back to the dvh layout (still fine unscrolled).
      return () => root.classList.remove('chat-page');
    }

    const update = () => {
      // Keyboard overlap = layout viewport height − what's actually visible.
      const overlap = window.innerHeight - vv.height - vv.offsetTop;
      const open = overlap > KEYBOARD_MIN_PX;
      root.classList.toggle('kb-open', open);
      // The REAL visible height (tracks toolbar show/hide AND the keyboard), which
      // the shell is sized to — precise where `dvh` drifts.
      root.style.setProperty('--kvh', `${Math.round(vv.height)}px`);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.classList.remove('kb-open', 'chat-page');
      root.style.removeProperty('--kvh');
    };
  }, []);
}

/**
 * useVisualViewportBox — publish the VISIBLE rectangle so a fixed OVERLAY can sit
 * exactly inside it: `--vv-h` (height) and `--vv-t` (offset from the layout top).
 *
 * Same root cause as the hook above, different shape of victim. `position: fixed` is
 * anchored to the LAYOUT viewport, which iOS Safari does not shrink for the keyboard.
 * So a `fixed inset-0` drawer stays full height, its composer ends up under the
 * keyboard, and Safari then pans the visual viewport to hunt for the focused field,
 * dragging the whole overlay off-screen and leaving the page behind it showing through
 * as a big empty band. That is the Ask-Kelly drawer bug.
 *
 * `useKeyboardViewport` cannot be reused for it: that one marks the document
 * `chat-page`, which pins `body { position: fixed }` and would throw away the
 * underlying page's scroll position the moment the drawer opened. An overlay must
 * leave the page beneath it exactly as it found it, so this hook only publishes
 * measurements and lets the overlay size itself.
 *
 * Both `resize` and `scroll` matter: resize fires when the keyboard opens/closes,
 * scroll fires when Safari pans, and following the pan is what keeps the drawer glued
 * to the visible area instead of sliding away under it.
 *
 * Side-effecting only (no re-renders). Mount it in an overlay that owns the screen.
 */
export function useVisualViewportBox(): void {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return; // no API: the caller's `100%` / `top: 0` fallbacks stand
    const root = document.documentElement;

    const update = () => {
      root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vv-t', `${Math.round(vv.offsetTop)}px`);
    };

    update();
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      root.style.removeProperty('--vv-h');
      root.style.removeProperty('--vv-t');
    };
  }, []);
}

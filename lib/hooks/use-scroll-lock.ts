'use client';

/**
 * useScrollLock — freeze the page behind an overlay, safely when several overlap.
 *
 * THE BUG THIS REPLACES. Every overlay used to save `body.style.overflow`, set it to
 * `hidden`, and put the saved value back on close. That is correct alone and wrong the
 * moment two overlap, because the second one saves the FIRST one's lock:
 *
 *   A opens    saved=''        body=hidden
 *   B opens    saved='hidden'  body=hidden
 *   A closes                   body=''
 *   B closes                   body='hidden'   <- stranded
 *
 * B faithfully restores what it found. The page is then unscrollable until a reload,
 * on EVERY route, because an inline style on `body` survives client-side navigation.
 * The realistic path is the Kelly dock, which floats above every page and can close
 * while a modal is still up.
 *
 * THE FIX. One lock, reference counted. The first holder records the real prior value
 * and freezes; later holders only add to the count; the page thaws when the LAST holder
 * lets go. Out-of-order closes cannot strand it, because no holder ever reads the live
 * value except the first.
 *
 * The counting rule is kept as pure functions so it is testable without a DOM (tests
 * run in node). See [[simple-mode]] for the overlays that use it.
 */
import { useEffect } from 'react';

export interface ScrollLockState {
  /** How many mounted overlays currently want the page frozen. */
  holders: number;
  /** What `body.style.overflow` was before the FIRST holder froze it. */
  saved: string | null;
}

export const NO_LOCK: ScrollLockState = { holders: 0, saved: null };

/** `write` is what to assign to `body.style.overflow`, or null to leave it alone. */
export interface LockStep {
  state: ScrollLockState;
  write: string | null;
}

/** Take the lock. Only the first holder touches the DOM or records the prior value. */
export function acquireLock(s: ScrollLockState, current: string): LockStep {
  if (s.holders > 0) return { state: { ...s, holders: s.holders + 1 }, write: null };
  return { state: { holders: 1, saved: current }, write: 'hidden' };
}

/** Let go. Only the last holder thaws the page, and it restores the ORIGINAL value. */
export function releaseLock(s: ScrollLockState): LockStep {
  if (s.holders <= 0) return { state: NO_LOCK, write: null }; // already thawed
  if (s.holders === 1) return { state: NO_LOCK, write: s.saved ?? '' };
  return { state: { ...s, holders: s.holders - 1 }, write: null };
}

// One lock for the whole document, so every overlay counts against the same tally.
let current = NO_LOCK;

/**
 * Freeze page scrolling while `locked` is true. Safe to nest and safe to unmount in any
 * order. Pass the overlay's own open flag; it releases on close AND on unmount.
 */
export function useScrollLock(locked: boolean): void {
  useEffect(() => {
    if (!locked) return;
    const taken = acquireLock(current, document.body.style.overflow);
    current = taken.state;
    if (taken.write != null) document.body.style.overflow = taken.write;
    return () => {
      const freed = releaseLock(current);
      current = freed.state;
      if (freed.write != null) document.body.style.overflow = freed.write;
    };
  }, [locked]);
}

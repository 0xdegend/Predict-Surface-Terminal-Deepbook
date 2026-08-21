import { describe, it, expect } from 'vitest';
import { acquireLock, releaseLock, NO_LOCK, type ScrollLockState } from './use-scroll-lock';

/** Drive the rule the way the hook does, against a stand-in for `body.style.overflow`. */
function run(steps: ('open' | 'close')[], startBody = '') {
  let state: ScrollLockState = NO_LOCK;
  let body = startBody;
  for (const step of steps) {
    const r = step === 'open' ? acquireLock(state, body) : releaseLock(state);
    state = r.state;
    if (r.write != null) body = r.write;
  }
  return { body, state };
}

describe('scroll lock', () => {
  it('freezes on the first holder and thaws on the last', () => {
    expect(run(['open']).body).toBe('hidden');
    expect(run(['open', 'close']).body).toBe('');
  });

  it('stays frozen while a second overlay is still open', () => {
    expect(run(['open', 'open', 'close']).body).toBe('hidden');
    expect(run(['open', 'open', 'close', 'close']).body).toBe('');
  });

  it('survives closing OUT OF ORDER — the exact bug it replaces', () => {
    // A opens, B opens, A closes, B closes. The old save/restore pattern left the page
    // stranded at 'hidden' here, on every route, until a reload.
    expect(run(['open', 'open', 'close', 'close']).body).toBe('');
  });

  it('restores a pre-existing inline value rather than blanking it', () => {
    expect(run(['open', 'close'], 'scroll').body).toBe('scroll');
    expect(run(['open', 'open', 'close', 'close'], 'scroll').body).toBe('scroll');
  });

  it('never records a later holder\'s view of the value', () => {
    // The second acquire must not overwrite `saved`, which is how 'hidden' used to get
    // saved as if it were the page's real setting.
    const a = acquireLock(NO_LOCK, 'scroll');
    const b = acquireLock(a.state, 'hidden');
    expect(b.state.saved).toBe('scroll');
    expect(b.write).toBeNull();
  });

  it('ignores an extra release instead of writing over the page', () => {
    const r = releaseLock(NO_LOCK);
    expect(r.write).toBeNull();
    expect(r.state).toEqual(NO_LOCK);
    expect(run(['open', 'close', 'close']).body).toBe('');
  });

  it('handles a strict-mode remount (open, close, open) still frozen', () => {
    const { body, state } = run(['open', 'close', 'open']);
    expect(body).toBe('hidden');
    expect(state.holders).toBe(1);
  });
});

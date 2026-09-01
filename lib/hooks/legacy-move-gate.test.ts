/**
 * Which first-run screen a wallet gets after a redeploy.
 *
 * Both the portfolio card and the trade-screen modal branch on the same two reads, and
 * getting the branch wrong is not cosmetic: a returning trader shown the plain first-run
 * card is told to set up an account while nothing on screen mentions the money they
 * already have, which reads as "your funds are gone".
 *
 * These are the decision rules, extracted so they can be asserted without mounting React.
 */
import { describe, it, expect } from 'vitest';
import { MIN_RECLAIM_BASE } from './use-legacy-move';

/** What the two reads report. `wrapperKnown` is separate from `wrapperExists` on purpose:
 *  a failed read must never be mistaken for an answer. */
interface Reads {
  wrapperKnown: boolean;
  wrapperExists: boolean;
  legacyLoading: boolean;
  legacyBalance: bigint;
}

type Screen = 'portfolio' | 'loading' | 'first-run' | 'migrate';

/** Mirrors the branch in portfolio-panel. */
function screenFor(r: Reads): Screen {
  if (!r.wrapperKnown || (r.wrapperKnown && r.wrapperExists)) return 'portfolio';
  if (r.legacyLoading) return 'loading';
  return r.legacyBalance >= MIN_RECLAIM_BASE ? 'migrate' : 'first-run';
}

const reads = (o: Partial<Reads> = {}): Reads => ({
  wrapperKnown: true,
  wrapperExists: false,
  legacyLoading: false,
  legacyBalance: 0n,
  ...o,
});

describe('first-run screen selection', () => {
  it('gives a brand-new wallet the plain first-run card', () => {
    expect(screenFor(reads())).toBe('first-run');
  });

  it('gives a returning trader with old funds the migration card', () => {
    expect(screenFor(reads({ legacyBalance: 12_843_449_977n }))).toBe('migrate');
  });

  it('waits for the old-release read rather than guessing', () => {
    // The two cards say very different things, so showing first-run and swapping to
    // migrate a moment later is worse than a brief wait on a once-only screen.
    expect(screenFor(reads({ legacyLoading: true }))).toBe('loading');
    expect(screenFor(reads({ legacyLoading: true, legacyBalance: 12_843_449_977n }))).toBe('loading');
  });

  it('never shows a first-run screen when the account read FAILED', () => {
    // readWrapper throws on a transport failure, leaving wrapperExists false with loading
    // already finished. The old `!wrapperExists` test read that as "never traded here" and
    // offered a returning trader an account they already had.
    expect(screenFor(reads({ wrapperKnown: false }))).toBe('portfolio');
    expect(screenFor(reads({ wrapperKnown: false, legacyBalance: 12_843_449_977n }))).toBe('portfolio');
  });

  it('shows the portfolio to anyone who already has an account here', () => {
    expect(screenFor(reads({ wrapperExists: true }))).toBe('portfolio');
    // Even with funds still on the old release: they get the dismissable BANNER on the
    // portfolio, not a card that blocks the whole screen.
    expect(screenFor(reads({ wrapperExists: true, legacyBalance: 12_843_449_977n }))).toBe('portfolio');
  });

  it('ignores dust so a rounding remainder cannot pin a migration screen forever', () => {
    expect(screenFor(reads({ legacyBalance: MIN_RECLAIM_BASE - 1n }))).toBe('first-run');
    expect(screenFor(reads({ legacyBalance: MIN_RECLAIM_BASE }))).toBe('migrate');
    // 3.11 DUSDC — the real leftover found on 7-29 — is well clear of the floor.
    expect(screenFor(reads({ legacyBalance: 3_110_000n }))).toBe('migrate');
  });
});

describe('what the move does', () => {
  /** Mirrors `createsAccount` in useLegacyMove, which decides whether the PTB includes
   *  `account_registry::new`. Wrong either way aborts the whole transaction. */
  const createsAccount = (wrapperKnown: boolean, wrapperExists: boolean) => wrapperKnown && !wrapperExists;

  it('creates the account when there is none here', () => {
    expect(createsAccount(true, false)).toBe(true);
  });

  it('does not try to create one that already exists', () => {
    expect(createsAccount(true, true)).toBe(false);
  });

  it('refuses to decide from a read that never succeeded', () => {
    // `createAccount: true` for a wallet that already has an account aborts, and false for
    // one that does not aborts on the deposit. Either way the move fails, so the guard is
    // to not sign at all until the read has actually answered.
    expect(createsAccount(false, false)).toBe(false);
  });
});

describe('the trade-screen onboarding modal', () => {
  /** Mirrors the `open` gate in OnboardFundModal. */
  const opens = (o: {
    owner: boolean;
    dismissed: boolean;
    legacyLoading: boolean;
    legacyBalance: bigint;
    firstTimer: boolean;
  }) =>
    o.owner &&
    !o.dismissed &&
    !o.legacyLoading &&
    !(o.legacyBalance >= MIN_RECLAIM_BASE) &&
    o.firstTimer;

  const base = { owner: true, dismissed: false, legacyLoading: false, legacyBalance: 0n, firstTimer: true };

  it('opens for a genuine first-timer', () => {
    expect(opens(base)).toBe(true);
  });

  it('stays shut for someone with a balance on the old release', () => {
    // The portfolio owns that conversation. An unprompted interstitial about moving funds
    // is not something this screen should ever raise.
    expect(opens({ ...base, legacyBalance: 12_843_449_977n })).toBe(false);
    expect(opens({ ...base, legacyBalance: 3_110_000n })).toBe(false);
  });

  it('waits for the old-release read instead of opening and vanishing', () => {
    expect(opens({ ...base, legacyLoading: true })).toBe(false);
  });

  it('still opens when only dust is left behind', () => {
    // Dust is not a migration, and it must not cost a new trader their onboarding.
    expect(opens({ ...base, legacyBalance: MIN_RECLAIM_BASE - 1n })).toBe(true);
  });
});

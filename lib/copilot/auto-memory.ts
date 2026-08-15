/**
 * lib/copilot/auto-memory.ts — auto-remember: Kelly quietly records a trader's revealed
 * style so passive continuity has something real to greet them with, without the trader
 * having to say "remember that …".
 *
 * Two rules keep it useful instead of noisy:
 *   1. It records a DERIVED PREFERENCE (leans UP, prefers safer bets, trades ranges), not an
 *      event log of every ticket. The note reads naturally as a greeting bullet.
 *   2. It writes at most ONCE PER SESSION per wallet (claimAutoRememberSlot), so a burst of
 *      trades can't flood the store. The manual "remember …" path is unaffected.
 *
 * The write only happens when the wallet is already signed in to memory (the host checks
 * `signedIn`), so auto-remember never triggers a signature prompt mid-trade. Pure + testable;
 * the actual write goes through lib/copilot/memory-client. See the wiring in the chat hosts.
 */

/** Minimal shape of a placed binary bet needed to describe a trader's lean. */
export interface BetStyleInput {
  isUp: boolean;
  conviction: string; // 'safe' | 'bold' | 'even' (from BetSuggestion)
}

/** A concise, greeting-ready note for a placed binary bet. */
export function styleNoteForBet(bet: BetStyleInput): string {
  const dir = bet.isUp ? 'UP' : 'DOWN';
  if (bet.conviction === 'safe') return `leans ${dir} and prefers safer bets`;
  if (bet.conviction === 'bold') return `leans ${dir} and likes bolder, higher-payout bets`;
  return `leans ${dir}`;
}

/** A concise, greeting-ready note for a placed range bet. */
export function styleNoteForRange(): string {
  return 'likes range bets on BTC';
}

/* --------------------------- once-per-session --------------------------- */
// Module-level so the full Kelly page and the global dock share one slot per wallet per
// browser session (a reload clears it, which is fine — a fresh note per visit is desirable).

const _claimed = new Set<string>();

/**
 * Claim this session's single auto-remember slot for a wallet. Returns true for the first
 * caller (which should then write), false thereafter. Claimed optimistically so two quick
 * trades can't both write; a failed write just forfeits auto-remember until the next visit.
 */
export function claimAutoRememberSlot(owner: string): boolean {
  const k = owner.toLowerCase();
  if (_claimed.has(k)) return false;
  _claimed.add(k);
  return true;
}

/** Test-only: reset the per-session claims. */
export function _resetAutoRememberClaims(): void {
  _claimed.clear();
}

/**
 * lib/leaderboard/faucet-participants.ts — fold Skew's starter-grant faucet
 * claimers into the Skew leaderboard.
 *
 * A wallet that claimed the starter grant onboarded THROUGH the app — a real Skew
 * user, even before it places a trade. We surface those wallets on the Skew board
 * with a small participation point so onboarding shows up in the standing, and the
 * UI badges the ones that haven't traded yet as "Starter" (viaFaucet + 0 trades) so
 * they're never presented as if they traded. See leaderboard-panel.
 *
 * The faucet ledger (grant:done:<addr>) is keyed by address only, so its wallets
 * already span every deployment (6-24 / 7-29 / 8-06) — this overlay is cumulative by
 * construction, matching the legacy-carryover model. Applied server-side in
 * /api/v2/leaderboard AFTER mergeLegacyCarryover, so real traders (live + carried
 * over) win and a claimer who also traded keeps their real stats.
 *
 * Pure + deterministic (the claimer list is injected), so it unit-tests cleanly.
 */
import type { V2LeaderboardRow } from './v2';
import { sortV2Rows } from './v2';

/** Points a faucet-only wallet contributes. Deliberately tiny: it registers the
 *  onboard in the standing without competing with real trading points. */
export const FAUCET_PARTICIPANT_POINTS = 1;

/**
 * Overlay the faucet claimers onto a live/legacy-merged Skew board. Returns a NEW
 * sorted array; never mutates its input.
 *  - a wallet that traded (already on the board) is only FLAGGED `viaFaucet` — its
 *    real points/volume/trades are untouched (no participation point added, so a
 *    trader is never inflated by having also claimed);
 *  - a wallet that only claimed (not on the board) is added as a 0-trade row carrying
 *    the participation point, flagged `viaFaucet` so the UI badges it "Starter".
 */
export function mergeFaucetParticipants(
  rows: V2LeaderboardRow[],
  claimers: readonly string[],
): V2LeaderboardRow[] {
  if (claimers.length === 0) return rows;

  const byOwner = new Map<string, V2LeaderboardRow>();
  for (const r of rows) byOwner.set(r.owner.toLowerCase(), { ...r });

  for (const raw of claimers) {
    const key = raw.toLowerCase();
    const existing = byOwner.get(key);
    if (existing) {
      // Already a trader (live or carried over): mark the onboard, don't touch stats.
      existing.viaFaucet = true;
    } else {
      byOwner.set(key, {
        owner: key,
        points: FAUCET_PARTICIPANT_POINTS,
        volume: 0,
        trades: 0,
        viaSkew: true,
        viaFaucet: true,
      });
    }
  }
  return sortV2Rows([...byOwner.values()], 'points');
}

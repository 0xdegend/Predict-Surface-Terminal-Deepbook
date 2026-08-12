/**
 * lib/rewards/eligibility.ts — the Founding Traders reward allowlist.
 *
 * A FROZEN snapshot (reward-snapshot.json) of the wallets eligible for the one-time
 * 50 DUSDC gift: everyone who had placed a bet through Skew at capture time, minus the
 * venue bot (never a Skew trader) and every team/admin wallet. Frozen on purpose —
 * eligibility can't drift and a wallet created after the announcement can never farm
 * the reward. The claim rail (Phase 1) checks membership here before the treasury pays,
 * and the on-chain dedupe marker ([[wallet-mix-tracking]]-style KV) enforces one claim.
 *
 * To re-snapshot (e.g. a future campaign), regenerate the JSON from the live board and
 * bump `campaign`; the claim marker namespace keys off `campaign`, so a new campaign is
 * a clean slate without touching old claims.
 */
import snapshot from './reward-snapshot.json';

export interface RewardEligibleRow {
  owner: string;
  trades: number;
  volume: number;
  points: number;
}
interface RewardSnapshot {
  campaign: string;
  title: string;
  capturedAt: string;
  network: string;
  criteria: string;
  rewardDusdc: number;
  rewardBaseUnits: string;
  count: number;
  totalDusdc: number;
  rows: RewardEligibleRow[];
}

const SNAP = snapshot as RewardSnapshot;

/** Campaign id — also the KV claim-marker namespace, so campaigns never collide. */
export const REWARD_CAMPAIGN = SNAP.campaign;
export const REWARD_TITLE = SNAP.title;
/** The gift size in DUSDC base units (@6dec). The server is authoritative; the client
 *  uses it only to label the experience. */
export const REWARD_BASE_UNITS = BigInt(SNAP.rewardBaseUnits);
export const REWARD_DUSDC = SNAP.rewardDusdc;
export const REWARD_CAPTURED_AT = SNAP.capturedAt;

/** owner (lowercased) → snapshot row, for O(1) eligibility + display. */
const BY_OWNER: Map<string, RewardEligibleRow> = new Map(
  SNAP.rows.map((r) => [r.owner.toLowerCase(), r]),
);

export const REWARD_ELIGIBLE_COUNT = BY_OWNER.size;
export const REWARD_TOTAL_DUSDC = SNAP.totalDusdc;

/** Is this wallet on the frozen allowlist? Case-insensitive. */
export function isRewardEligible(owner: string | null | undefined): boolean {
  return !!owner && BY_OWNER.has(owner.toLowerCase());
}

/** The snapshot row for a wallet (trades / volume / points at capture), or null. */
export function rewardRowFor(owner: string | null | undefined): RewardEligibleRow | null {
  if (!owner) return null;
  return BY_OWNER.get(owner.toLowerCase()) ?? null;
}

/** All eligible owner addresses (lowercased). */
export function rewardEligibleOwners(): string[] {
  return [...BY_OWNER.keys()];
}

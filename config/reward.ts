/**
 * config/reward.ts — browser-safe config for the Founding Traders reward.
 *
 * Display/gating hints ONLY. The treasury private key, the authoritative amount, and
 * the eligibility allowlist all live server-side (REWARD_* env + lib/rewards/*, read in
 * /api/reward/*). The client never learns the full allowlist — it asks the status
 * endpoint whether IT is eligible. Mirrors the config/route split of [[starter-grant]].
 */

/** Show the claim banner + experience. Operator turns this on (=1) AFTER funding the
 *  reward treasury. Off => the banner/experience stay hidden even for eligible wallets. */
export const REWARD_ENABLED = process.env.NEXT_PUBLIC_REWARD_ENABLED === '1';

/** Dev-only preview: surface the banner + gift experience for ANY connected wallet and
 *  play the claim as a simulation (no treasury send, no signing, no ledger write) so the
 *  whole moment can be reviewed without juggling eligible logins. The server still gates
 *  a REAL claim, so this can never move funds. Never set this in production. */
export const REWARD_PREVIEW = process.env.NEXT_PUBLIC_REWARD_PREVIEW === '1';

/** The reward UI is visible when it's really on OR we're previewing it. */
export const REWARD_VISIBLE = REWARD_ENABLED || REWARD_PREVIEW;

/** Campaign id — must match the snapshot's `campaign` (the KV claim namespace). */
export const REWARD_CAMPAIGN = process.env.NEXT_PUBLIC_REWARD_CAMPAIGN ?? 'founding-traders';

/** Display amount for the experience copy (DUSDC). The server is authoritative. */
export const REWARD_DISPLAY_DUSDC = Number(process.env.NEXT_PUBLIC_REWARD_DUSDC ?? '50');

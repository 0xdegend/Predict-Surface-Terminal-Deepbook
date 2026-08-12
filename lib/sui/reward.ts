/**
 * lib/sui/reward.ts — client transport for the traders reward payout.
 *
 * Thin POST to /api/reward/claim (the server holds the treasury key and enforces every
 * gate). Returns the payout digest + amounts (base-unit strings — DUSDC @6dec, SUI
 * @9dec/MIST). The account DEPOSIT that follows is signed by the user (owner-gated),
 * built with lib/sui/v2/account.ts `buildDepositTx`; this call only moves the reward
 * treasury -> the user's wallet. See [[founding-traders-reward]].
 */
export class RewardClaimError extends Error {
  /** Stable reason from the server (e.g. 'not_eligible', 'already_claimed'). */
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = 'RewardClaimError';
    this.code = code;
  }
}

export interface RewardClaimResult {
  digest: string;
  /** DUSDC paid (base units, @6dec). */
  amount: string;
  /** SUI dripped for gas (base units, MIST) — '0' for gasless (Google) wallets. */
  suiAmount: string;
}

/**
 * Ask the server to pay the reward to `address`. `includeSui` should be true for
 * external (Slush) wallets that pay their own gas and need a little SUI to sign the
 * follow-up deposit; false for Google (Enoki, gasless). Throws RewardClaimError.
 */
export async function claimReward(
  address: string,
  opts: { includeSui?: boolean } = {},
): Promise<RewardClaimResult> {
  const res = await fetch('/api/reward/claim', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ address, includeSui: opts.includeSui ?? false }),
  });
  const data = (await res.json().catch(() => ({}))) as Partial<RewardClaimResult> & {
    error?: string;
    code?: string;
  };
  if (!res.ok) {
    throw new RewardClaimError(data.error ?? 'Reward claim failed', data.code ?? 'error');
  }
  return { digest: data.digest ?? '', amount: data.amount ?? '0', suiAmount: data.suiAmount ?? '0' };
}

/**
 * reward-shared — the view contract for the reward claim, shared by the full-screen
 * 3-D gift overlay and the reduced-motion modal fallback. The orchestrator
 * (RewardClaimExperience) owns the hooks and hands both presentations the same
 * phase + handlers, so the two views stay in lockstep. See [[founding-traders-reward]].
 */
import { predictV2Config } from '@/config/predict';
import type { RewardClaimPhase } from '@/lib/hooks/use-reward';
import type { MascotMood } from '@/lib/mascot';

export interface RewardClaimView {
  open: boolean;
  phase: RewardClaimPhase;
  /** DUSDC the trader receives. */
  amount: number;
  sym: string;
  /** Treasury payout digest once it confirms (null in preview / before payout). */
  paidDigest: string | null;
  /** Payout landed but the deposit step didn't finish — funds are safe in the wallet. */
  inWalletOnly: boolean;
  error: string | null;
  /** A payout/signing is in flight — don't let the dialog be dismissed. */
  busy: boolean;
  onClaim: () => void;
  onClose: () => void;
  onStartTrading: () => void;
}

export const REWARD_EXPLORER = (digest: string) =>
  `https://suiscan.xyz/${predictV2Config.network}/tx/${digest}`;

/** The fox reacts to the moment. */
export const REWARD_MOOD: Record<RewardClaimPhase, MascotMood> = {
  idle: 'confident',
  paying: 'thinking',
  depositing: 'thinking',
  done: 'won',
  error: 'loss',
};

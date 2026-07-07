/**
 * lib/sui/v2/invert.ts — invert the fair-price curve onto v2's admission-tick
 * grid. Shares the bisection core with legacy (lib/svi/invert.ts's
 * bisectUpFairStrike) and snaps to v2's grid via snapStrikeToAdmission instead
 * of the legacy oracle grid — same split as lib/sui/v2/abort.ts vs
 * lib/sui/abort.ts (share the deployment-agnostic core, fork only the
 * grid-shaped decoration).
 */
import { bisectUpFairStrike, payoutMultiple } from '@/lib/svi/invert';
import type { SviFloat } from '@/lib/svi/svi';
import { fromFloat } from '@/config/scale';
import { snapStrikeToAdmission } from './ticks';

export { payoutMultiple };

type IntLike = bigint | number | string;

/** Strike (1e9-scaled, snapped to the admission grid) whose UP fair price ≈ `targetUp`. */
export function strikeForUpFair(
  targetUp: number,
  forward: number,
  svi: SviFloat,
  admissionTickSize: IntLike,
  settlement: number | null = null,
): bigint {
  const strike = bisectUpFairStrike(targetUp, forward, svi, settlement);
  return snapStrikeToAdmission(fromFloat(strike), admissionTickSize);
}

/** Strike for a target DIRECTION fair (handles UP vs DOWN). */
export function strikeForDirectionFair(
  targetDir: number,
  forward: number,
  svi: SviFloat,
  admissionTickSize: IntLike,
  isUp: boolean,
  settlement: number | null = null,
): bigint {
  const targetUp = isUp ? targetDir : 1 - targetDir;
  return strikeForUpFair(targetUp, forward, svi, admissionTickSize, settlement);
}

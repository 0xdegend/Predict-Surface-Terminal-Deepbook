/**
 * lib/autopilot/engine-gate.ts — when the Autopilot engine has to be driving.
 *
 * The engine used to be called inside the Autopilot panel, so it only ran while that
 * panel was on screen: opening the Trade page unmounted it and a live run quietly
 * stopped placing trades. It now lives above every /v2 route, which raises the opposite
 * question, because a driver that polls markets, pricers and spot must NOT run on the
 * leaderboard for somebody who has never armed anything.
 *
 * This is that decision, kept pure so it can be read and tested without React:
 *   - a live run (armed, or paused waiting for gas) always drives, wherever the trader
 *     has navigated to;
 *   - a stopped run with positions still tracked drives too, because those still have to
 *     be read off-chain and scored before the run's record is complete;
 *   - otherwise it drives only while a view is actually asking for it, which is the
 *     Autopilot panel showing its live market read before anything is armed.
 */
import type { AutopilotStatus } from '@/lib/store/autopilot-store';

export interface EngineGateInput {
  status: AutopilotStatus;
  /** Positions the run is still tracking (open, or expired and awaiting settlement). */
  openCount: number;
  /** How many mounted views have asked for a live engine. */
  wanted: number;
}

export function engineShouldRun({ status, openCount, wanted }: EngineGateInput): boolean {
  if (status === 'armed' || status === 'paused') return true;
  if (status === 'stopped' && openCount > 0) return true;
  return wanted > 0;
}

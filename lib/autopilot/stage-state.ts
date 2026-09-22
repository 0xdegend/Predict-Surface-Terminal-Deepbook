/**
 * lib/autopilot/stage-state.ts — what Kelly is doing on the Stage, as a pure function.
 *
 * The Stage is a 3-D scene, but none of the thinking belongs in a frame loop. Everything
 * that decides what a trader sees (which beat she is in, what she is standing on, what the
 * caption says) is computed here from real run state, so it can be tested without a GPU
 * and so the scene stays a renderer rather than a place where behaviour hides.
 *
 * THE IDLE PROBLEM. Markets are one and five minutes and runs are paced, so for most of a
 * run there is no trade happening. A character who freezes in that gap is worse than the
 * dashboard she replaced. The fix is that waiting is not nothing: Kelly stands on the
 * market she currently rates highest and the caption says, in the engine's own words, why
 * she is not buying it. The quiet stretch becomes the part where you watch her judge, and
 * it is all real, which is why `scouting` gets as much care here as `won` does.
 *
 * ON CELEBRATION. `won` and `lost` are short, equal-length, single-expression beats. They
 * report an outcome; they do not reward the trade. Robinhood shipped confetti on fills and
 * pulled it in March 2021 after Massachusetts regulators named that exact mechanic in a
 * complaint, and this app is heading for mainnet with an agent that fires unattended. A fox
 * whose face changes is character. A fox who throws a party every time money moves is a
 * slot machine, so the reaction here is deliberately proportionate and deliberately brief.
 */
import type { MascotMood } from '@/lib/mascot';
import type { TradeSide } from './policy';
import { isScanFresh, type ScanSnapshot } from './scan';

export type StageBeat =
  /** Armed, but the live context is not rich enough to reason on yet. */
  | 'warming'
  /** Armed and watching. Nothing clears the trader's rules. The long tail of a run. */
  | 'scouting'
  /** A pick clears and is top-ranked. She is standing on the one she would buy. */
  | 'lining_up'
  /** A trade just fired. */
  | 'placing'
  /** Money is on the table and the market is running to expiry. */
  | 'holding'
  | 'won'
  | 'lost'
  /** Session gas ran low. The run resumes on its own, so this is a sit-down, not a stop. */
  | 'paused'
  /** Stopped or never armed. */
  | 'resting';

export interface StagePosition {
  marketId: string;
  /** Settlement timestamp (ms). The scene focuses whichever open trade settles soonest. */
  expiry: number;
  pnlUsd: number;
}

export interface StageInput {
  status: 'idle' | 'armed' | 'paused' | 'stopped';
  /** True once the engine has markets and a tape to reason on. */
  ready: boolean;
  /** The engine's priceable universe this tick. Used only when there is no scan yet. */
  candidateCount: number;
  scan: ScanSnapshot | null;
  positions: StagePosition[];
  /** When the run last placed a trade (ms epoch), or null. */
  lastPlacedAt: number | null;
  /** The most recent settlement this run scored, or null. */
  lastSettlement: { marketId: string; won: boolean; at: number } | null;
  now: number;
}

export interface StageView {
  beat: StageBeat;
  mood: MascotMood;
  /** One plain line under the scene. Never a second copy of what the HUD already shows. */
  caption: string;
  /** The market Kelly stands on, or null when she has nowhere to be yet. */
  focusMarketId: string | null;
  /**
   * How animated she is, 0..1. Drives idle sway and step cadence in the scene, so the
   * difference between waiting and working is legible before you have read a word.
   */
  energy: number;
}

/**
 * How long a settlement holds the scene (ms).
 *
 * Long enough to read the result, short enough that it cannot become the point of
 * watching. Wins and losses get the SAME window on purpose: making the win linger is how
 * a reaction turns into a reward.
 */
export const REACTION_MS = 6_000;

/** How long a fresh placement reads as "placing" before it becomes "holding" (ms). */
export const PLACING_MS = 2_500;

const pct = (p: number): string => `${Math.round(p * 100)}%`;

const sideLabel = (s: TradeSide): string => (s === 'range' ? 'a range' : s);

/** The open trade that settles soonest. That is the one with something at stake now. */
function mostUrgent(positions: StagePosition[]): StagePosition | null {
  let best: StagePosition | null = null;
  for (const p of positions) if (!best || p.expiry < best.expiry) best = p;
  return best;
}

export function stageView(input: StageInput): StageView {
  const { status, ready, candidateCount, positions, lastPlacedAt, lastSettlement, now } = input;
  const scan = isScanFresh(input.scan, now) ? input.scan : null;

  // Not running. Nothing below applies, and a stopped run must not keep miming a scan.
  if (status === 'idle' || status === 'stopped') {
    return {
      beat: 'resting',
      mood: 'thinking',
      caption: status === 'stopped' ? 'Run finished.' : 'Not running.',
      focusMarketId: null,
      energy: 0,
    };
  }

  if (status === 'paused') {
    return {
      beat: 'paused',
      mood: 'thinking',
      caption: 'Paused while session gas is low. She picks back up on her own.',
      focusMarketId: mostUrgent(positions)?.marketId ?? null,
      energy: 0.1,
    };
  }

  // A settlement outranks everything else for its window: it is the only moment in a run
  // where something has actually resolved, and burying it under the next scan is how the
  // old dashboard managed to make winning feel like nothing happened.
  if (lastSettlement && now - lastSettlement.at < REACTION_MS) {
    return lastSettlement.won
      ? {
          beat: 'won',
          mood: 'won',
          caption: 'That one landed.',
          focusMarketId: lastSettlement.marketId,
          energy: 0.9,
        }
      : {
          beat: 'lost',
          mood: 'loss',
          caption: 'That one missed.',
          focusMarketId: lastSettlement.marketId,
          energy: 0.25,
        };
  }

  if (lastPlacedAt != null && now - lastPlacedAt < PLACING_MS) {
    return {
      beat: 'placing',
      mood: 'confident',
      caption: 'Placing the trade.',
      focusMarketId: mostUrgent(positions)?.marketId ?? scan?.ranked[0]?.marketId ?? null,
      energy: 1,
    };
  }

  if (positions.length > 0) {
    const urgent = mostUrgent(positions);
    return {
      beat: 'holding',
      mood: 'confident',
      caption:
        positions.length === 1
          ? 'Holding one trade to settlement.'
          : `Holding ${positions.length} trades to settlement.`,
      focusMarketId: urgent?.marketId ?? null,
      energy: 0.5,
    };
  }

  if (!ready || (candidateCount === 0 && !scan)) {
    return {
      beat: 'warming',
      mood: 'thinking',
      caption: 'Reading the live markets.',
      focusMarketId: null,
      energy: 0.2,
    };
  }

  // A pick that clears is one she would buy right now, and the only reason she has not is
  // pacing or a chain-side check further down the tick.
  const top = scan?.ranked[0];
  if (top) {
    return {
      beat: 'lining_up',
      mood: 'confident',
      caption: `Best value on the board: ${sideLabel(top.side)} at ${pct(top.prob)}.`,
      focusMarketId: top.marketId,
      energy: 0.75,
    };
  }

  // Scouting. The long quiet middle of a run, and the beat this whole screen lives or dies
  // on. She stands on the market she rates highest even though it did not clear, and the
  // caption is the engine's own hold reason, so the wait explains itself.
  return {
    beat: 'scouting',
    mood: 'thinking',
    caption: scoutCaption(scan, candidateCount),
    focusMarketId: scan?.best?.marketId ?? null,
    energy: 0.35,
  };
}

function scoutCaption(scan: ScanSnapshot | null, candidateCount: number): string {
  if (scan?.holdReason) return scan.holdReason;
  if (scan?.best) return `Best on offer is ${pct(scan.best.prob)}. Nothing clears your rules yet.`;
  const n = scan?.consideredCount ?? candidateCount;
  if (n <= 0) return 'Waiting for a market to price.';
  return n === 1 ? 'Watching one market. Nothing to buy yet.' : `Watching ${n} markets. Nothing to buy yet.`;
}

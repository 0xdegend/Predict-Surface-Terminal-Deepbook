/**
 * lib/autopilot/plan-phases.ts — the plan as the four things Autopilot actually does,
 * in the order it does them.
 *
 * `planSentence` (presets.ts) says the same thing in one line and is still what the
 * compact read-outs use. This is the expanded form: a trader deciding whether to hand
 * money to a bot needs to know the SHAPE of the loop, not just its parameters, and a
 * single sentence flattens "watches, picks, stakes, stops" into a spec.
 *
 * EVERY PHASE DESCRIBES REAL BEHAVIOUR. Each line here maps to a check in
 * lib/autopilot/policy:
 *
 *   watch → `tenor_not_allowed`
 *   pick  → `below_min_prob`, `side_not_allowed`, `leverage_too_high`
 *   stake → `max_concurrent_reached`, `cooldown_active`, `trade_cap_reached`
 *   stop  → `stopReason`: loss_limit, trade_cap_reached, budget_spent, plus armDurationMs
 *
 * Pure and string-only, so the copy is unit-testable and the component stays a
 * rendering concern. Numbers are always said out loud, never implied: the same rule
 * Kelly's setup conversation holds.
 */
import type { AutopilotLimits, AutopilotRules, Tenor } from './policy';

export type PlanPhaseId = 'watch' | 'pick' | 'stake' | 'stop';

export interface PlanPhase {
  id: PlanPhaseId;
  /** Two or three words. The verb, plus the number if one belongs in a heading. */
  title: string;
  /** One plain sentence saying what that step means. */
  detail: string;
}

/** Windows as a trader picked them, matching the labels on the Customize controls. */
const TENOR_WORDS: Record<Tenor, string> = {
  soonest: 'the next few minutes',
  hour: 'about an hour',
  today: 'later today',
};

const TENOR_ORDER: Tenor[] = ['soonest', 'hour', 'today'];

function listWords(xs: string[]): string {
  if (xs.length === 0) return '';
  if (xs.length === 1) return xs[0];
  return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`;
}

function windowWords(tenors: Tenor[]): string {
  return listWords(TENOR_ORDER.filter((t) => tenors.includes(t)).map((t) => TENOR_WORDS[t]));
}

function sideWords(sides: AutopilotRules['sides']): string {
  const parts: string[] = [];
  if (sides.includes('up')) parts.push('UP');
  if (sides.includes('down')) parts.push('DOWN');
  if (sides.includes('range')) parts.push('range');
  return listWords(parts);
}

function money(v: number): string {
  return `$${v % 1 === 0 ? v : v.toFixed(2)}`;
}

function minutesWords(ms: number): string {
  const mins = Math.round(ms / 60_000);
  if (mins < 60) return `${mins} minutes`;
  const hours = mins / 60;
  return Number.isInteger(hours) ? `${hours} hour${hours === 1 ? '' : 's'}` : `${hours.toFixed(1)} hours`;
}

function secondsWords(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} seconds` : minutesWords(ms);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function planPhases(rules: AutopilotRules, limits: AutopilotLimits): PlanPhase[] {
  const windows = windowWords(rules.tenors);
  const sides = sideWords(rules.sides);
  const lev = rules.maxLeverage > 1 ? `, up to ${rules.maxLeverage}x` : '';

  return [
    {
      id: 'watch',
      title: 'Watches',
      // An empty window list is not a detail to gloss over: it is the setting that makes
      // a run sit there doing nothing, so it says so instead of reading as normal.
      detail: windows
        ? `Every open BTC market settling in ${windows}.`
        : 'No windows picked yet, so nothing would qualify.',
    },
    {
      id: 'pick',
      title: 'Picks one',
      detail: sides
        ? `Only a bet she rates ${Math.round(rules.minProb * 100)}% or better to win, going ${sides}${lev}.`
        : 'No direction picked yet, so nothing would qualify.',
    },
    {
      id: 'stake',
      title: `Stakes ${money(limits.perTradeUsd)}`,
      detail: `Up to ${plural(limits.maxTrades, 'bet', 'bets')}, ${plural(
        limits.maxConcurrent,
        'open at a time',
        'open at a time',
      )}, ${secondsWords(limits.cooldownMs)} between them.`,
    },
    {
      id: 'stop',
      title: 'Stops itself',
      detail: `After ${minutesWords(limits.armDurationMs)}, or ${plural(
        limits.maxConsecutiveLosses,
        'loss',
        'losses',
      )} in a row, or once the ${money(limits.budgetUsd)} is used up.`,
    },
  ];
}

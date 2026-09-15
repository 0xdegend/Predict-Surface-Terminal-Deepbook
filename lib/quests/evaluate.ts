/**
 * lib/quests/evaluate.ts — the pure quest evaluator.
 *
 * Given the catalog (config/quests) and whatever has actually been measured about a
 * trader, work out where they stand. No network, no wallet, no store, no clock beyond
 * what the caller passes in, so every branch is unit-tested before a point is awarded.
 *
 * TWO DISTINCTIONS THIS MODULE EXISTS TO PROTECT.
 *
 * 1. `undefined` is not `0`. A metric nothing measured is UNAVAILABLE: the quest is real
 *    and listed, but we decline to claim a number for it. A metric we did compute and
 *    found empty is 0, and the quest is active at 0%. Collapsing those two would either
 *    show a permanent, unexplained 0% on a quest that cannot move, or imply we checked
 *    something we never looked at. Deposits is the live case: nothing in the order log
 *    records one, so it stays absent until the account read can settle it either way.
 *
 * 2. A window is a claim about coverage. A source declares the span it covers, and a
 *    quest is only scored by a source whose window matches. Without that rule a weekly
 *    target scored off a lifetime total completes on day one and never resets, and a
 *    lifetime target scored off a weekly total resets every Monday and pays again. A
 *    quest with no source covering its span reports unavailable rather than a number
 *    that looks authoritative and is not.
 *
 * Awarding (once, durably) is deliberately NOT here. This module answers "where do they
 * stand"; a ledger answers "have they already been paid", and keeping the two apart is
 * what lets this one be a pure function.
 */
import { QUESTS, QUEST_COLLATERAL, type QuestDef, type QuestMetricKey, type QuestWindow } from '@/config/quests';

/**
 * What has been measured about one trader. Every key is optional and the absence of a
 * key is meaningful: nothing measured it, which is not the same as it being zero.
 */
export type QuestMetrics = Partial<Record<QuestMetricKey, number>>;

/** A measured snapshot, together with the honest span it covers. */
export interface MetricSource {
  window: QuestWindow;
  metrics: QuestMetrics;
}

export type QuestState =
  /** Measurable and not yet reached. */
  | 'active'
  /** Measurable and reached. */
  | 'complete'
  /** Nothing feeds this metric over this window yet, so we make no claim. */
  | 'unavailable';

export interface QuestProgress {
  id: string;
  state: QuestState;
  /** 0..1, clamped both ends. Always 0 when unavailable. */
  progress: number;
  /** Where they are, in the metric's own unit. 0 when unavailable. */
  current: number;
  target: number;
  /** Ready-to-render progress text, e.g. "32 / 50 DUSDC", "1 / 3 wins", "Complete". */
  label: string;
  /** Points this quest pays on completion (not whether they have been paid). */
  points: number;
}

/** Trim a measured figure so a float from the fold does not render as 32.000000001. */
function trim(n: number): number {
  return Math.round(n * 100) / 100;
}

function labelFor(def: QuestDef, current: number, state: QuestState, symbol: string): string {
  if (state === 'unavailable') return 'Coming soon';
  if (state === 'complete') return 'Complete';
  const shown = Math.min(current, def.target);
  if (def.unit === 'dusdc') return `${trim(shown)} / ${def.target} ${symbol}`;
  return def.noun ? `${trim(shown)} / ${def.target} ${def.noun}` : `${trim(shown)} / ${def.target}`;
}

/** The source that may legitimately score this quest, or undefined if none can. */
function sourceFor(def: QuestDef, sources: readonly MetricSource[]): MetricSource | undefined {
  return sources.find((s) => s.window === def.window);
}

/**
 * Evaluate one quest. `symbol` names the collateral in money labels; it defaults to the
 * catalog's constant so a rename stays a one-line change there.
 */
export function evaluateQuest(
  def: QuestDef,
  sources: readonly MetricSource[],
  symbol: string = QUEST_COLLATERAL,
): QuestProgress {
  const src = sourceFor(def, sources);
  const raw = src?.metrics[def.metric];
  const base = { id: def.id, target: def.target, points: def.points };
  const blocked = (): QuestProgress => ({
    ...base,
    state: 'unavailable',
    progress: 0,
    current: 0,
    label: labelFor(def, 0, 'unavailable', symbol),
  });

  if (raw == null || !Number.isFinite(raw)) return blocked();
  // A target of zero would make every quest instantly complete via a divide by zero.
  // The catalog forbids it; this refuses to guess if one ever slips through.
  if (!(def.target > 0)) return blocked();

  const current = Math.max(0, raw); // a signed metric (net PnL) must not read as negative progress
  const progress = Math.min(1, current / def.target);
  const state: QuestState = progress >= 1 ? 'complete' : 'active';
  return { ...base, state, progress, current: trim(current), label: labelFor(def, current, state, symbol) };
}

/** Evaluate the whole catalog, in catalog order. */
export function evaluateAll(
  sources: readonly MetricSource[],
  defs: readonly QuestDef[] = QUESTS,
  symbol: string = QUEST_COLLATERAL,
): QuestProgress[] {
  return defs.map((d) => evaluateQuest(d, sources, symbol));
}

/** Points from the quests currently complete. What they have EARNED, not been paid. */
export function earnedPoints(rows: readonly QuestProgress[]): number {
  return rows.reduce((n, r) => (r.state === 'complete' ? n + r.points : n), 0);
}

/** How many of the listed quests can actually be scored right now. Drives honest copy. */
export function measurableCount(rows: readonly QuestProgress[]): number {
  return rows.reduce((n, r) => (r.state === 'unavailable' ? n : n + 1), 0);
}

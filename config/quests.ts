/**
 * config/quests.ts — the quest catalog, as data.
 *
 * A quest is a milestone measured from the trader's own on-chain activity and paid in
 * Skew Points. Declaring them here (rather than inline in the panel, where they started
 * life as illustrative mock rows) means the screen, the evaluator and its tests all read
 * one table, and adding a quest is an entry rather than a code change.
 *
 * Two fields carry the whole safety story:
 *
 *   `metric` names the ONE number the quest is a function of. A quest can never be
 *   completed by anything the evaluator did not measure, and a metric nothing feeds yet
 *   reports as unavailable instead of silently sitting at zero (lib/quests/evaluate).
 *
 *   `window` says what span that number must cover, and the evaluator will only score a
 *   quest from a source that covers exactly that span. Without the rule, a weekly target
 *   scored off a lifetime total completes on day one and never resets, and a lifetime
 *   target scored off a weekly total resets every Monday and pays again.
 *
 * Points are the reward while this runs on testnet. The rates below are the ones already
 * on screen and are deliberately generous against the trading-points formula in
 * lib/points/score.ts, because a quest is an onboarding nudge, not a yield.
 */

/**
 * How the settlement collateral is written in quest copy. One constant so the ticker is
 * never a literal scattered through the catalog. The protocol renamed the Move type from
 * `dusdc::DUSDC` to `usdc::USDC` on 9-12, and the app now displays USDC even though the
 * on-chain `coin_registry::Currency` still returns "DUSDC" (see the `quote` note in
 * config/predict.ts for why that divergence is deliberate).
 */
export const QUEST_COLLATERAL = 'USDC';

/** Grouping for the panel's filter tabs. Matches the shipped design. */
export type QuestCategory = 'onboarding' | 'volume' | 'skill' | 'markets';

/**
 * The measurable quantities a quest may key off. Adding a key here is a promise that
 * something fills it; until then the evaluator reports the quest as unavailable.
 */
export type QuestMetricKey =
  | 'trades'
  | 'volume'
  | 'wins'
  | 'netPnl'
  | 'daysHeld'
  /**
   * Deposits into the Predict account. Nothing dates a deposit (there is no such event in
   * the order log), so this is measured as a LOWER BOUND from account evidence, and only
   * ever over a lifetime. See lib/quests/from-activity.
   */
  | 'deposits'
  /** Closes that reached oracle settlement, as opposed to the trader closing early. */
  | 'settledCloses'
  /** Distinct expiry markets traded. */
  | 'distinctMarkets'
  /** Range (two-boundary) positions minted, as opposed to a plain up or down bet. */
  | 'rangeTrades';

/**
 * The span a metric must cover. `week` resets on the Monday boundary the panel already
 * counts down to; `lifetime` is every trade the wallet has ever made, which is why it
 * needs a carried-forward source rather than the live window.
 */
export type QuestWindow = 'week' | 'lifetime';

/** How a progress number is written out, so "50" reads as money or as a count. */
export type QuestUnit = 'count' | 'dusdc';

export interface QuestDef {
  id: string;
  category: QuestCategory;
  /** Icon id resolved to a component by the panel, so this stays free of React. */
  icon: 'rocket' | 'coins' | 'trending' | 'zap' | 'target' | 'compass';
  title: string;
  desc: string;
  /** Skew Points awarded once, on completion. */
  points: number;
  metric: QuestMetricKey;
  /** The value of `metric` that completes it. Always > 0. */
  target: number;
  window: QuestWindow;
  unit: QuestUnit;
  /** Noun for the progress label on counted quests, e.g. "3 / 5 wins". */
  noun?: string;
}

export const QUESTS: readonly QuestDef[] = [
  {
    id: 'first-trade',
    category: 'onboarding',
    icon: 'rocket',
    title: 'First Prediction',
    desc: 'Mint your first binary or range position on any market.',
    points: 100,
    metric: 'trades',
    target: 1,
    window: 'lifetime',
    unit: 'count',
  },
  {
    id: 'fund-manager',
    category: 'onboarding',
    icon: 'coins',
    title: 'Fund Your Account',
    desc: 'Deposit into your Predict account to start trading.',
    points: 50,
    metric: 'deposits',
    target: 1,
    window: 'lifetime',
    unit: 'count',
  },
  {
    id: 'volume-climber',
    category: 'volume',
    icon: 'trending',
    title: 'Volume Climber',
    desc: `Trade 50 ${QUEST_COLLATERAL} of notional volume this week.`,
    points: 300,
    metric: 'volume',
    target: 50,
    window: 'week',
    unit: 'dusdc',
  },
  {
    id: 'market-maker',
    category: 'volume',
    icon: 'trending',
    title: 'Market Mover',
    desc: `Reach 250 ${QUEST_COLLATERAL} of cumulative trading volume.`,
    points: 1000,
    metric: 'volume',
    target: 250,
    window: 'lifetime',
    unit: 'dusdc',
  },
  {
    id: 'sharp-shooter',
    category: 'skill',
    icon: 'zap',
    title: 'Sharp Shooter',
    desc: 'Close three winning positions (decided, payout above cost).',
    points: 500,
    metric: 'wins',
    target: 3,
    window: 'lifetime',
    unit: 'count',
    noun: 'wins',
  },
  {
    id: 'diamond-hands',
    category: 'skill',
    icon: 'target',
    title: 'Hold to Settlement',
    desc: 'Carry a position all the way to oracle settlement.',
    points: 200,
    metric: 'settledCloses',
    target: 1,
    window: 'lifetime',
    unit: 'count',
  },
  {
    id: 'explorer',
    category: 'markets',
    icon: 'compass',
    title: 'Market Explorer',
    desc: 'Open positions on three different markets.',
    points: 400,
    metric: 'distinctMarkets',
    target: 3,
    window: 'lifetime',
    unit: 'count',
    noun: 'markets',
  },
  {
    id: 'range-rider',
    category: 'markets',
    icon: 'target',
    title: 'Range Rider',
    desc: 'Open your first range position on the surface.',
    points: 200,
    metric: 'rangeTrades',
    target: 1,
    window: 'lifetime',
    unit: 'count',
  },
];

export const questById = (id: string): QuestDef | undefined => QUESTS.find((q) => q.id === id);

/** Every point on the board if a trader finished all of them. Drives the panel's header. */
export const TOTAL_QUEST_POINTS = QUESTS.reduce((n, q) => n + q.points, 0);

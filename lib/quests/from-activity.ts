/**
 * lib/quests/from-activity.ts — one trader's real activity, folded into quest metrics.
 *
 * This is the bridge between what the chain recorded and what config/quests asks about.
 * It is pure: hand it an order log and it returns measured numbers, no network, no
 * wallet, no clock of its own. The hook (lib/hooks/use-quest-progress) supplies the
 * inputs; the evaluator (./evaluate) turns these into progress.
 *
 * WHY THE ORDER LOG AND NOTHING ELSE.
 *
 * The obvious source was the leaderboard indexer, but its tally is per-owner totals with
 * no timestamps, no market ids and no tick pairs, so four of the eight quests could never
 * be scored from it. The account's own order EVENT log carries all of it: a mint records
 * the stake, the market, the tick pair and the moment; a redeem records what came back and
 * whether the market had settled. So everything below folds out of ONE query the app
 * already holds (the same `accountOrders` cache the portfolio, trade history and trader
 * style read), and the quests page adds no fetch of its own.
 *
 * WHAT IS STILL NOT MEASURED. Deposits do not appear in the order log at all, so they
 * arrive separately as account evidence (see `AccountEvidence`) and are reported as a
 * LOWER BOUND: we can prove a deposit happened, we cannot prove one never did. A lower
 * bound can only ever under-credit a trader, never pay one twice, which is the direction
 * an unclaimable number should err in.
 *
 * WINDOWS. Two sources come back: `lifetime` (everything, including trades carried over
 * from retired deployments) and `week` (since 00:00 UTC on the most recent Monday, the
 * same boundary the competitions countdown runs to). The evaluator refuses to score a
 * quest with a source whose span does not match, so producing both here is what lets a
 * weekly quest reset while a lifetime one never does.
 */
import { fromQuote } from '@/config/scale';
import { isRangeTicks, POS_INF_TICK } from '@/lib/sui/v2/ticks';
import type { V2OrderEvent } from '@/lib/api/v2/types';
import type { PastPrediction } from '@/lib/portfolio/history';
import type { MetricSource, QuestMetrics } from './evaluate';

const WEEK_MS = 604_800_000;

const n = (v: unknown): number => (v == null ? 0 : Number(v));

/**
 * 00:00 UTC on the most recent Monday at or before `nowMs`. Derived from the same
 * next-Monday anchor the rewards countdown uses (app/_components/rewards/shared), so the
 * week a quest measures is exactly the week the page counts down to.
 */
export function weekStartUTC(nowMs: number): number {
  const d = new Date(nowMs);
  const day = d.getUTCDay(); // 0 = Sun, 1 = Mon
  const daysAhead = (8 - day) % 7 || 7; // strictly future, matching nextMondayUTC
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + daysAhead) - WEEK_MS;
}

/**
 * What we can see of the trader's Predict account. Deliberately three-valued: `known`
 * false means the read has not landed (or failed), which the account hook is emphatic
 * about keeping separate from a real "no account" — a five-second RPC hiccup must never
 * read as "this wallet has never traded here".
 */
export interface AccountEvidence {
  /** True once the account read actually succeeded. */
  known: boolean;
  /** True when the account exists AND currently holds collateral. */
  funded: boolean;
}

export interface ActivityInput {
  /** The owner's order events, mints and redeems, in any order. */
  orders: readonly V2OrderEvent[];
  /** Closed trades carried over from retired deployments (lib/portfolio/legacy-history). */
  legacy?: readonly PastPrediction[];
  account?: AccountEvidence;
  nowMs: number;
}

/** A running tally, so the lifetime and weekly passes share one fold. */
interface Tally {
  trades: number;
  volume: number;
  wins: number;
  netPnl: number;
  settledCloses: number;
  markets: Set<string>;
  rangeTrades: number;
}

const emptyTally = (): Tally => ({
  trades: 0,
  volume: 0,
  wins: 0,
  netPnl: 0,
  settledCloses: 0,
  markets: new Set(),
  rangeTrades: 0,
});

/** A mint's tick pair, defaulting to the binary sentinels when a field is missing, so an
 *  event we cannot read counts as a plain bet rather than inventing a range. */
function mintIsRange(e: V2OrderEvent): boolean {
  const lo = e.lower_tick != null ? BigInt(e.lower_tick) : 0n;
  const hi = e.higher_tick != null ? BigInt(e.higher_tick) : POS_INF_TICK;
  return isRangeTicks(lo, hi);
}

/**
 * Fold the order log into one tally, counting only events at or after `since`.
 *
 * Mints and redeems are two passes for the same reason the leaderboard aggregator uses
 * two: a redeem's cost basis lives on its mint, joined by `position_root_id`. The join
 * always looks at the WHOLE log even for a windowed pass, because a position minted last
 * week and closed this week still has its basis back there.
 *
 * Payout rules mirror lib/portfolio/v2 and lib/leaderboard/v2-aggregate exactly, so a
 * quest's win count can never disagree with the number on the trader's own history tab:
 * a settled close pays `payout_amount`, a live close pays `redeem_amount` net of fees,
 * and a liquidation pays nothing.
 */
function foldOrders(orders: readonly V2OrderEvent[], since: number, t: Tally): void {
  const mints = new Map<string, V2OrderEvent>();
  for (const e of orders) {
    if (e.kind === 'order_minted' && e.position_root_id != null) mints.set(String(e.position_root_id), e);
  }

  for (const e of orders) {
    const ts = e.checkpoint_timestamp_ms ?? 0;
    if (ts < since) continue;

    if (e.kind === 'order_minted') {
      t.trades += 1;
      // The SAME definition of volume the leaderboard uses: the net premium staked, before
      // entry fees. Two surfaces quoting one trader's volume must not disagree.
      t.volume += fromQuote(n(e.net_premium));
      if (e.expiry_market_id) t.markets.add(e.expiry_market_id);
      if (mintIsRange(e)) t.rangeTrades += 1;
      continue;
    }

    const kind = String(e.kind ?? '');
    if (!/redeemed/i.test(kind)) continue;
    const settled = /settled/i.test(kind);
    const liquidated = /liquidat/i.test(kind);
    // A settled close is one that rode all the way to the oracle. A live close is the
    // trader banking or cutting early, which is a different act and a different quest.
    if (settled) t.settledCloses += 1;

    const mint = e.position_root_id != null ? mints.get(String(e.position_root_id)) : undefined;
    const totalQty = n(mint?.quantity) || n(e.quantity_closed);
    const closedQty = n(e.quantity_closed) || totalQty;
    const frac = totalQty > 0 ? closedQty / totalQty : 1;
    const cost = fromQuote(n(mint?.net_premium) * frac);
    const fees = settled ? 0 : n(e.trading_fee) + n(e.builder_fee) + n(e.penalty_fee);
    const gross = liquidated ? 0 : fromQuote(settled ? n(e.payout_amount) : n(e.redeem_amount));
    const payout = Math.max(0, gross - fromQuote(fees));
    const pnl = payout - cost;
    t.netPnl += pnl;
    if (pnl > 0) t.wins += 1;
  }
}

/**
 * Fold carried-over trades from retired deployments. These arrive already derived, as
 * closed history rows, which costs a little precision: a position closed in two parts is
 * two rows, so it adds two to `trades` where the live log would add one mint. That only
 * ever inflates a count a returning trader has long since passed, and the alternative is
 * telling someone who traded the 6-24 deployment that they have never made a prediction.
 *
 * A carried row rode to settlement when it closed at or after its market's expiry; closing
 * before that is an early close. Rows with no expiry recorded are left out of that count
 * rather than guessed at.
 */
function foldLegacy(rows: readonly PastPrediction[], since: number, t: Tally): void {
  for (const r of rows) {
    if (r.settledAt < since) continue;
    t.trades += 1;
    t.volume += r.cost;
    t.netPnl += r.pnl;
    if (r.result === 'won') t.wins += 1;
    if (r.expiry > 0 && r.settledAt >= r.expiry) t.settledCloses += 1;
    if (r.oracleId) t.markets.add(r.oracleId);
    if (r.band) t.rangeTrades += 1;
  }
}

/** The measured keys of a tally. `deposits` is added by the caller, and only to the
 *  lifetime source: nothing dates a deposit, so no weekly claim can be made about one. */
function metricsOf(t: Tally): QuestMetrics {
  return {
    trades: t.trades,
    volume: t.volume,
    wins: t.wins,
    netPnl: t.netPnl,
    settledCloses: t.settledCloses,
    distinctMarkets: t.markets.size,
    rangeTrades: t.rangeTrades,
  };
}

/**
 * Evidence of a deposit, as a lower bound.
 *
 * A funded account proves it. So does a trade: the collateral for a mint comes out of the
 * Predict account, and it only gets there by being deposited. Absent both, we say zero,
 * which is right for the new trader this quest is aimed at and merely under-credits the
 * rare veteran who funded, traded nothing and withdrew it all again. While the account
 * read has not landed we say nothing at all, so a slow RPC never renders as "not funded".
 */
function depositsLowerBound(account: AccountEvidence | undefined, traded: boolean): number | undefined {
  if (traded) return 1;
  if (!account?.known) return undefined;
  return account.funded ? 1 : 0;
}

/**
 * The trader's measured metrics, one source per span. Always returns both sources, so a
 * quest is never left unscored because its window happened to be empty: an empty week is
 * a measurement (0), not an absence.
 */
export function sourcesFromActivity(input: ActivityInput): MetricSource[] {
  const { orders, legacy = [], account, nowMs } = input;

  const life = emptyTally();
  foldOrders(orders, 0, life);
  foldLegacy(legacy, 0, life);

  const since = weekStartUTC(nowMs);
  const week = emptyTally();
  foldOrders(orders, since, week);
  foldLegacy(legacy, since, week);

  const deposits = depositsLowerBound(account, life.trades > 0);
  const lifetime: QuestMetrics = metricsOf(life);
  if (deposits != null) lifetime.deposits = deposits;

  return [
    { window: 'lifetime', metrics: lifetime },
    { window: 'week', metrics: metricsOf(week) },
  ];
}

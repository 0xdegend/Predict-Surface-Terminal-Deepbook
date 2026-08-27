/**
 * lib/autopilot/run-tape.ts — a run as a timeline, not a list.
 *
 * WHY THIS EXISTS. The run log answers "what just happened" perfectly and "what has this
 * thing been DOING" not at all: it is reverse-chronological, every row is the same shape,
 * and the two facts that make a run legible (when the bets landed, and how long each one
 * lived) are spread across rows you have to scroll between and reassemble by timestamp.
 *
 * The tape puts one run on one axis. Bursts, cooldown gaps, overlapping bets and the
 * settle points are all visible without reading a word, which is the shape of the run.
 * It sits ABOVE the log rather than replacing it: a tape cannot carry the text, the
 * digests or the hold reasons, so the two together are strictly more than either.
 *
 * Pure and tested, like the rest of lib/autopilot. Nothing here reaches into the store:
 * the inputs are structural, so a component can hand it positions, results and log lines
 * without this module importing the store (which imports lib/autopilot itself).
 */
import type { TradeSide } from './policy';

/** How many rows of bars the tape will stack before it starts sharing them. Runs cap
 *  concurrency at 4, so this is the real ceiling rather than an arbitrary one. */
const MAX_LANES = 4;

/** What a still-open position has to tell the tape. */
export interface TapeOpen {
  marketId: string;
  side: TradeSide;
  /** When it was placed. Older persisted positions predate this field. */
  openedAt?: number;
  expiry: number;
  sizeUsd: number;
  dryRun: boolean;
}

/** What a finished trade has to tell the tape. */
export interface TapeSettled {
  marketId: string;
  side: TradeSide;
  /** When it was placed. */
  at: number;
  outcome: 'won' | 'lost' | 'pending';
  stake: number;
  pnlUsd: number;
}

/** What a log line has to tell the tape: when a trade resolved, and where Kelly passed. */
export interface TapeLogLine {
  kind: string;
  at: number;
  text: string;
  marketId?: string;
}

export type TapeOutcome = 'open' | 'won' | 'lost' | 'pending';

export interface TapeTrade {
  marketId: string;
  side: TradeSide;
  outcome: TapeOutcome;
  dryRun: boolean;
  /** Both ends as fractions of the axis, 0..1, already clamped. */
  from: number;
  to: number;
  /** Which row this bar sits on (0-based). */
  lane: number;
  /** The whole trade in one line, for the bar's tooltip. */
  label: string;
}

/** A moment Kelly looked at a market and passed, as a position on the axis. */
export interface TapeHold {
  at: number;
  pos: number;
  text: string;
}

export interface RunTape {
  /** The axis, in ms epoch. */
  startAt: number;
  endAt: number;
  /** Where the run was scheduled to end, as a fraction of the axis. 1 unless something
   *  overran it, which is the only reason the axis is ever longer than the run. */
  plannedEnd: number;
  trades: TapeTrade[];
  holds: TapeHold[];
  /** Rows in use, at least 1 so the track always has a height. */
  lanes: number;
}

const DIR: Record<TradeSide, string> = { up: 'UP', down: 'DOWN', range: 'RANGE' };

function money(n: number): string {
  const abs = Math.abs(n);
  const body = abs % 1 === 0 ? abs.toFixed(0) : abs.toFixed(2);
  return `${n < 0 ? '-' : ''}$${body}`;
}

function label(side: TradeSide, stake: number, outcome: TapeOutcome, pnlUsd: number): string {
  const head = `${DIR[side]} · ${money(stake)}`;
  switch (outcome) {
    case 'won':
      return `${head} · won ${pnlUsd >= 0 ? '+' : ''}${money(pnlUsd)}`;
    case 'lost':
      return `${head} · lost ${money(pnlUsd)}`;
    case 'pending':
      return `${head} · never settled`;
    case 'open':
      return `${head} · still open`;
  }
}

/**
 * Pack bars into rows so overlapping bets sit side by side instead of on top of each
 * other. Greedy by start time, which is optimal for interval graphs: the first row that
 * is free takes it. Past MAX_LANES the least-recently-busy row takes the overflow, so a
 * misconfigured run draws something honest rather than growing without bound.
 */
function assignLanes(sorted: { from: number; to: number }[]): number[] {
  const lastEnd: number[] = [];
  return sorted.map((t) => {
    const free = lastEnd.findIndex((end) => end <= t.from);
    if (free >= 0) {
      lastEnd[free] = t.to;
      return free;
    }
    if (lastEnd.length < MAX_LANES) {
      lastEnd.push(t.to);
      return lastEnd.length - 1;
    }
    let best = 0;
    for (let i = 1; i < lastEnd.length; i++) if (lastEnd[i] < lastEnd[best]) best = i;
    lastEnd[best] = Math.max(lastEnd[best], t.to);
    return best;
  });
}

/**
 * Build the tape for one run.
 *
 * The axis runs from the moment it armed to the LATER of its scheduled end and whatever
 * actually happened, so a settlement that lands after the run's own clock ran out is
 * still on the tape instead of clipped off the right edge. `now` is deliberately not an
 * input: the playhead is the component's business, and keeping it out means this only
 * recomputes when the run itself changes rather than once a second.
 */
export function buildRunTape({
  armedAt,
  armDurationMs,
  open,
  settled,
  log,
}: {
  armedAt: number;
  armDurationMs: number;
  open: TapeOpen[];
  settled: TapeSettled[];
  log: TapeLogLine[];
}): RunTape {
  // When each trade resolved, and when it was placed, straight off the log. A settled
  // result records the placement time but not the settlement one, and the log has both.
  const resolvedAt = new Map<string, number>();
  const placedAt = new Map<string, number>();
  for (const e of log) {
    if (!e.marketId) continue;
    if (e.kind === 'settled' && !resolvedAt.has(e.marketId)) resolvedAt.set(e.marketId, e.at);
    if (e.kind === 'placed' && !placedAt.has(e.marketId)) placedAt.set(e.marketId, e.at);
  }

  interface Raw {
    marketId: string;
    side: TradeSide;
    outcome: TapeOutcome;
    dryRun: boolean;
    startMs: number;
    endMs: number;
    label: string;
  }

  const raw: Raw[] = [];
  for (const t of settled) {
    const start = placedAt.get(t.marketId) ?? t.at;
    // A trade that never settled has no end to draw to, so it stays a point at its
    // placement rather than inventing a length it did not have.
    const end = resolvedAt.get(t.marketId) ?? start;
    raw.push({
      marketId: t.marketId,
      side: t.side,
      outcome: t.outcome,
      dryRun: false,
      startMs: Math.min(start, end),
      endMs: Math.max(start, end),
      label: label(t.side, t.stake, t.outcome, t.pnlUsd),
    });
  }
  for (const p of open) {
    const start = p.openedAt ?? placedAt.get(p.marketId) ?? armedAt;
    raw.push({
      marketId: p.marketId,
      side: p.side,
      outcome: 'open',
      dryRun: p.dryRun,
      startMs: start,
      // An open bar reaches to its expiry: that is when it decides, and seeing how far
      // off that is, is most of why the tape is worth the space.
      endMs: Math.max(start, p.expiry),
      label: label(p.side, p.sizeUsd, 'open', 0),
    });
  }

  raw.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const startAt = armedAt;
  const endAt = Math.max(armedAt + Math.max(1, armDurationMs), ...raw.map((r) => r.endMs));
  const span = Math.max(1, endAt - startAt);
  const at = (ms: number) => Math.min(1, Math.max(0, (ms - startAt) / span));

  const spans = raw.map((r) => ({ from: at(r.startMs), to: at(r.endMs) }));
  const lanes = assignLanes(spans);

  const trades: TapeTrade[] = raw.map((r, i) => ({
    marketId: r.marketId,
    side: r.side,
    outcome: r.outcome,
    dryRun: r.dryRun,
    from: spans[i].from,
    to: spans[i].to,
    lane: lanes[i],
    label: r.label,
  }));

  const holds: TapeHold[] = log
    .filter((e) => e.kind === 'held')
    .map((e) => ({ at: e.at, pos: at(e.at), text: e.text }))
    .sort((a, b) => a.at - b.at);

  return {
    startAt,
    endAt,
    plannedEnd: at(armedAt + armDurationMs),
    trades,
    holds,
    lanes: Math.max(1, lanes.length ? Math.max(...lanes) + 1 : 1),
  };
}

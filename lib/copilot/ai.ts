/**
 * lib/copilot/ai.ts — the client seam + shared shapes for Kelly's optional LLM
 * tier (Claude Haiku, server-side at /api/copilot).
 *
 * The hybrid: the rule router (parseIntent → respondToIntent) still handles every
 * money-touching path deterministically (quotes, bet setup, placement, adjust,
 * close). Claude is called ONLY for the read long tail — the questions the rules
 * drop to `help` — grounded in a compact, pre-fetched context so it never invents
 * a number and never places a trade. On any error/timeout/disabled/capped, the
 * caller falls back to the deterministic help reply, so Claude is purely additive.
 *
 * Cost is controlled end to end: Haiku, one call (context passed in, no tool round
 * trips), short max_tokens, a cached system prompt, trimmed history, and both a
 * per-session (client) and per-day (server) cap. See app/api/copilot/route.ts.
 *
 * This module is pure + isomorphic (types + a fetch wrapper + a pure formatter);
 * the SDK call itself lives server-only in the route.
 */

/** The compact, already-known facts handed to Claude. Small on purpose — every
 *  field is one short line, and unknown fields are omitted, so the token cost of
 *  grounding stays tiny. NEVER put secrets here; it's the user's own public data. */
export interface AiContext {
  spot?: number | null;
  /** The surface's directional lean, from the same `recommendation()` the read uses. */
  lean?: { pick: 'up' | 'down' | 'range'; confidence: 'slight' | 'clear' } | null;
  /** How big a move is priced in vs recently realized. */
  vol?: 'calm' | 'normal' | 'elevated' | null;
  fearGreed?: { value: number; label: string } | null;
  /** Today's notable scheduled market events (macro calendar), most important first.
   *  `when` is a coarse relative time ("in about 3 hours", "earlier today"). */
  events?: { title: string; when: string }[] | null;
  /** The soonest tradeable expiry, in minutes (rounded), or null when none live. */
  nextExpiryMins?: number | null;
  wallet?: { connected: boolean; hasAccount: boolean; balance: number } | null;
  /** The trader's settled track record + last result (already de-scaled to DUSDC). */
  record?: {
    total: number;
    wins: number;
    losses: number;
    winRate: number; // 0..1
    realizedPnl: number;
    streak?: { won: boolean; count: number } | null;
    last?: { side: string; result: 'won' | 'lost'; pnl: number } | null;
  } | null;
}

export interface AiTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface AiRequest {
  message: string;
  /** Recent turns for continuity (the caller trims; the server caps again). */
  history: AiTurn[];
  context: AiContext;
}

export interface AiReply {
  /** False = no key / disabled / capped / errored → the caller uses the rule reply. */
  available: boolean;
  /** The answer, one string per paragraph. Absent when `available` is false. */
  text?: string[];
}

/** Whole dollars, thin thousands — kept local so this module has no UI deps. */
function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}
function usd2(n: number): string {
  const s = n < 0 ? '-' : '';
  return `${s}$${Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/**
 * Turn the context into a short plain-text block for the prompt — one line per fact,
 * unknowns omitted. Pure + unit-tested; kept lean so grounding costs a handful of
 * tokens, not a JSON dump.
 */
export function formatAiContext(c: AiContext): string {
  const lines: string[] = [];
  if (c.spot != null) lines.push(`BTC price now: ${usd(c.spot)}.`);
  if (c.lean) {
    const dir = c.lean.pick === 'range' ? 'no clear direction (rangebound)' : `leaning ${c.lean.pick}`;
    lines.push(`Market read: ${dir}${c.lean.pick === 'range' ? '' : ` (${c.lean.confidence})`}.`);
  }
  if (c.vol) lines.push(`Expected move: ${c.vol}.`);
  if (c.fearGreed) lines.push(`Fear and Greed index: ${c.fearGreed.value} out of 100 (${c.fearGreed.label}).`);
  if (c.events && c.events.length) {
    const list = c.events.slice(0, 4).map((e) => `${e.title} (${e.when})`).join('; ');
    lines.push(`Today's scheduled market events: ${list}. These are just the schedule, not a prediction of the outcome.`);
  }
  if (c.nextExpiryMins != null) lines.push(`Soonest market settles in about ${c.nextExpiryMins} minute${c.nextExpiryMins === 1 ? '' : 's'}.`);
  if (c.wallet) {
    if (!c.wallet.connected) lines.push('Wallet: not connected.');
    else if (!c.wallet.hasAccount) lines.push('Wallet: connected, but no trading account yet.');
    else lines.push(`Wallet: connected, ${usd2(c.wallet.balance)} DUSDC free to trade.`);
  }
  if (c.record) {
    if (c.record.total === 0) lines.push('Track record: no settled bets yet.');
    else {
      const r = c.record;
      const streak = r.streak && r.streak.count >= 2 ? ` On a ${r.streak.count}-bet ${r.streak.won ? 'winning' : 'losing'} run.` : '';
      const last = r.last ? ` Last settled bet: a ${r.last.side} bet, ${r.last.result} (${usd2(r.last.pnl)}).` : '';
      lines.push(
        `Track record: ${r.wins} wins and ${r.losses} losses across ${r.total} settled bets (${Math.round(r.winRate * 100)}% win rate), ${usd2(r.realizedPnl)} realized.${streak}${last}`,
      );
    }
  }
  return lines.length ? lines.join('\n') : 'No live context is available right now.';
}

/**
 * A loose "is this about my own trading performance / track record?" check, used to
 * decide whether to offer the win-rate Share-to-X card under a Claude answer (the
 * rule tier attaches it to its own win-rate reply; the LLM long tail needs the same
 * affordance). Deliberately broad: a false positive just shows an extra share chip,
 * which is low-harm. The CALLER also gates on the trader actually having a record.
 */
export function isPerformanceQuestion(text: string): boolean {
  const t = text.toLowerCase();
  return /\bperform(?:ing|ance|ed)?\b|\bwin ?rate\b|\btrack record\b|\bprofitab|\bhow'?s my (?:trading|record|stats|betting)\b|\bhow (?:have|'?ve|has) i been (?:doing|trading|performing|betting)\b|\bhow am i (?:doing|trading|performing|betting)\b|\bmy (?:results|record|stats|win rate|performance)\b|\bbeen (?:doing|winning|trading)\b|\bhow many (?:bets?|trades?)?\s*(?:have i|did i|i)?\s*(?:won|win|lost|lose)\b|\bon a (?:hot )?(?:roll|streak)\b|\bam i (?:winning|profitable|doing well|any good)\b/.test(t);
}

/**
 * POST the read question + context to the server route. Returns `{available:false}`
 * on any non-OK response so the caller cleanly falls back to the rule reply. `signal`
 * lets the caller enforce a timeout.
 */
export async function askKellyAI(req: AiRequest, signal?: AbortSignal): Promise<AiReply> {
  try {
    const r = await fetch('/api/copilot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req),
      signal,
    });
    if (!r.ok) return { available: false };
    const data = (await r.json()) as AiReply;
    return data && Array.isArray(data.text) && data.text.length ? { available: true, text: data.text } : { available: false };
  } catch {
    return { available: false };
  }
}

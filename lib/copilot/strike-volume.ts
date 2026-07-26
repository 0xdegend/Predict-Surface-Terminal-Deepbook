/**
 * lib/copilot/strike-volume.ts — "which strike has the most volume?" for the
 * co-pilot. The surface itself is pure pricing (SVI), so volume comes from the
 * ORDERS feed instead: each mint carries its strike (as tick indices) and its
 * net premium (what the trader paid). We bucket mints by strike and sum the
 * premium — the SAME volume metric the analytics flow tape uses
 * (`marketVolumeFromOrders`), just grouped by strike instead of by market.
 *
 * Two scopes (chosen in the parser): the current live market ("right now") or
 * every open expiry. Pure — the screen fetches the orders and passes them in.
 */
import { fromQuote, toFloat } from '@/config/scale';
import { POS_INF_TICK } from '@/lib/sui/v2/ticks';
import { num, compact } from '@/lib/format';
import { timeLeftLabel, type CopilotReply } from './respond';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

export type StrikeDir = 'up' | 'down' | 'range';

/** One strike's traded volume on one market. */
export interface StrikeVolume {
  marketId: string;
  expiry: number;
  direction: StrikeDir;
  strike?: number; // up / down (float $)
  band?: { lower: number; higher: number }; // range
  volume: number; // summed net premium (DUSDC)
  bets: number;
}

export interface MarketOrders {
  market: V2Market;
  orders: V2OrderEvent[];
}

const isMint = (o: V2OrderEvent) => o.kind === 'order_minted';

/**
 * Bucket mint orders by strike (per market) and sum their premium, busiest first.
 * Ticks → price the SAME way positions do: `price = tick × tick_size`, with
 * `higher_tick = +∞` ⇒ UP, `lower_tick = 0` ⇒ DOWN, else a range band.
 */
export function aggregateStrikeVolume(inputs: MarketOrders[]): StrikeVolume[] {
  const buckets = new Map<string, StrikeVolume>();
  for (const { market, orders } of inputs) {
    const tickSize = toFloat(market.tick_size);
    const priceOf = (t: bigint) => Number(t) * tickSize;
    for (const o of orders) {
      if (!isMint(o)) continue;
      const lo = o.lower_tick != null ? BigInt(o.lower_tick) : 0n;
      const hi = o.higher_tick != null ? BigInt(o.higher_tick) : 0n;

      let direction: StrikeDir;
      let strike: number | undefined;
      let band: { lower: number; higher: number } | undefined;
      let keyPart: string;
      if (hi === POS_INF_TICK) {
        direction = 'up';
        strike = priceOf(lo);
        keyPart = `up:${lo}`;
      } else if (lo === 0n) {
        direction = 'down';
        strike = priceOf(hi);
        keyPart = `down:${hi}`;
      } else {
        direction = 'range';
        band = { lower: priceOf(lo), higher: priceOf(hi) };
        keyPart = `range:${lo}:${hi}`;
      }

      const key = `${market.expiry_market_id}|${keyPart}`;
      const vol = fromQuote(Number(o.net_premium ?? 0));
      const existing = buckets.get(key);
      if (existing) {
        existing.volume += vol;
        existing.bets += 1;
      } else {
        buckets.set(key, { marketId: market.expiry_market_id, expiry: market.expiry, direction, strike, band, volume: vol, bets: 1 });
      }
    }
  }
  return [...buckets.values()].sort((a, b) => b.volume - a.volume);
}

/** Plain label for a strike bucket: "UP $65,000" / "DOWN $64,900" / "a range …". */
function strikeLabel(b: StrikeVolume): string {
  if (b.direction === 'range' && b.band) return `a range bet between $${num(b.band.lower, 0)} and $${num(b.band.higher, 0)}`;
  return `${b.direction === 'down' ? 'DOWN' : 'UP'} $${num(b.strike ?? 0, 0)}`;
}

const money = (v: number) => (v >= 10_000 ? `$${compact(v)}` : `$${num(v, 0)}`);

/**
 * The plain-language "busiest strike" answer. `scope` = 'now' (the single live
 * market) or 'all' (every open expiry — so each line names when it settles).
 */
export function busiestStrikeReply(buckets: StrikeVolume[], opts: { scope: 'now' | 'all'; now: number }): CopilotReply {
  const ranked = buckets.filter((b) => b.volume > 0);
  if (ranked.length === 0) {
    return {
      text: [
        opts.scope === 'now'
          ? "No bets have gone through on the live market yet — it's quiet right now. Ask me to analyze it, or check back in a moment."
          : "No bets have gone through on any open market yet — it's quiet right now. Check back in a moment.",
      ],
    };
  }
  const when = (b: StrikeVolume) => (opts.scope === 'all' ? ` (settles ${timeLeftLabel(b.expiry, opts.now)})` : '');
  const top = ranked[0];
  const scopeWord = opts.scope === 'now' ? 'on the live market right now' : 'across all open markets';
  const text: string[] = [
    `The busiest strike ${scopeWord} is ${strikeLabel(top)}${when(top)} — ${money(top.volume)} staked across ${top.bets} ${top.bets === 1 ? 'bet' : 'bets'}.`,
  ];
  const rest = ranked.slice(1, 3);
  if (rest.length) {
    text.push(`Next busiest: ${rest.map((b) => `${strikeLabel(b)}${when(b)} — ${money(b.volume)}`).join('; ')}.`);
  }
  text.push('Want the odds on any of these? Say “odds at $X”, or “analyze this strike”.');
  return { text };
}

/**
 * The plain-language "how's the volume on the surface" overview: total staked, the
 * up vs down (vs range) split, and the busiest spot. Complements busiestStrikeReply
 * (which names one level) with the big picture. `scope` as above.
 */
export function surfaceVolumeReply(buckets: StrikeVolume[], opts: { scope: 'now' | 'all'; now: number }): CopilotReply {
  const ranked = buckets.filter((b) => b.volume > 0);
  if (ranked.length === 0) {
    return {
      text: [
        opts.scope === 'now'
          ? "It's quiet on the live market right now. No bets have gone through yet, which is normal between waves. Check back in a moment, or ask me to analyze it."
          : "It's quiet across the surface right now. No bets have gone through on any open market yet. A fresh market opens about every minute, so check back shortly.",
      ],
    };
  }

  const sum = (dir: StrikeDir) => ranked.filter((b) => b.direction === dir).reduce((s, b) => s + b.volume, 0);
  const total = ranked.reduce((s, b) => s + b.volume, 0);
  const bets = ranked.reduce((s, b) => s + b.bets, 0);
  const up = sum('up');
  const down = sum('down');
  const range = sum('range');
  const pct = (v: number) => Math.round((v / total) * 100);
  const rangeTail = range > 0 ? `, plus ${money(range)} in range bets` : '';
  const whereWord = opts.scope === 'now' ? 'on the live market right now' : 'across all open markets';

  const text: string[] = [
    `Right now ${money(total)} is staked ${whereWord}, across ${bets} ${bets === 1 ? 'bet' : 'bets'}.`,
  ];

  // Which way the money leans (up vs down among the directional bets).
  const dirTotal = up + down;
  if (dirTotal === 0) {
    text.push(`It's all range bets right now (${money(range)}), so traders are backing a zone rather than a side.`);
  } else if (Math.abs(up - down) < dirTotal * 0.15) {
    text.push(`It's split fairly evenly: ${money(up)} on UP and ${money(down)} on DOWN${rangeTail}.`);
  } else if (up > down) {
    text.push(`The money is leaning UP: ${money(up)} (${pct(up)}%) betting higher vs ${money(down)} (${pct(down)}%) lower${rangeTail}.`);
  } else {
    text.push(`The money is leaning DOWN: ${money(down)} (${pct(down)}%) betting lower vs ${money(up)} (${pct(up)}%) higher${rangeTail}.`);
  }

  // The busiest single spot.
  const top = ranked[0];
  const when = opts.scope === 'all' ? ` (settles ${timeLeftLabel(top.expiry, opts.now)})` : '';
  text.push(`The busiest spot is ${strikeLabel(top)}${when} with ${money(top.volume)}.`);

  text.push('Say “busiest strike” for the full ranking, or tell me a direction and I’ll set up a bet.');
  return { text };
}

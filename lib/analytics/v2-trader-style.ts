/**
 * lib/analytics/v2-trader-style.ts — classify v2 traders by how they bet, from the
 * per-market order feeds. Reuses the shared classifyStyle spine (lib/analytics/
 * trader-style) so a trader reads the same archetype everywhere; this only adapts
 * v2 mint EVENTS into the position shape the classifier reads.
 *
 * The classifier looks at just four fields per position — oracle, side, cost, and
 * entry probability — so each minted order maps cleanly to one, and range mints
 * fold into the separate rangeVolume the classifier takes.
 */
import { fromQuote } from '@/config/scale';
import { classifyStyle, type StyleArchetype, type TraderStyle } from './trader-style';
import { orderSide } from './v2-aggregate';
import type { V2OrderEvent } from '@/lib/api/v2/types';
import type { PositionSummary } from '@/lib/api/types';

export interface V2ClassifiedTrader {
  owner: string;
  style: TraderStyle;
  /** Total premium staked across their mints (DUSDC). */
  volume: number;
}

export interface V2StyleBucket {
  id: StyleArchetype['id'];
  label: string;
  count: number;
}

export interface V2TraderStyles {
  traders: V2ClassifiedTrader[];
  distribution: V2StyleBucket[];
  /** Number of traders that cleared the classifier's sample floor. */
  total: number;
}

/**
 * Classify every trader seen in the fanned-out order feeds. `topN` caps the
 * roster; the distribution counts all classified traders.
 */
export function classifyV2Traders(ordersByMarket: Map<string, V2OrderEvent[]>, topN = 12): V2TraderStyles {
  const byOwner = new Map<string, V2OrderEvent[]>();
  for (const orders of ordersByMarket.values()) {
    for (const o of orders) {
      if (o.kind !== 'order_minted' || !o.owner) continue;
      const list = byOwner.get(o.owner);
      if (list) list.push(o);
      else byOwner.set(o.owner, [o]);
    }
  }

  const classified: V2ClassifiedTrader[] = [];
  for (const [owner, orders] of byOwner) {
    const positions: PositionSummary[] = [];
    let rangeVolume = 0; // DUSDC float — the classifier adds this to binary volume
    let volume = 0;
    for (const o of orders) {
      const costFloat = fromQuote(Number(o.net_premium ?? 0));
      volume += costFloat;
      const side = orderSide(o.lower_tick, o.higher_tick);
      if (side === 'range') {
        rangeVolume += costFloat;
        continue;
      }
      // computeStyleStats reads only these four fields; the rest of PositionSummary
      // is irrelevant to classification, so a minimal object is faithful here.
      positions.push({
        oracle_id: String(o.expiry_market_id ?? ''),
        is_up: side === 'up',
        total_cost: Number(o.net_premium ?? 0), // base units — classifier de-scales
        average_entry_price: Number(o.entry_probability ?? 0), // 1e9 — classifier de-scales
      } as unknown as PositionSummary);
    }
    const style = classifyStyle(positions, rangeVolume);
    if (style.primary) classified.push({ owner, style, volume });
  }

  classified.sort((a, b) => b.volume - a.volume);

  const counts = new Map<StyleArchetype['id'], { label: string; count: number }>();
  for (const c of classified) {
    const p = c.style.primary!;
    const cur = counts.get(p.id);
    if (cur) cur.count += 1;
    else counts.set(p.id, { label: p.label, count: 1 });
  }
  const distribution: V2StyleBucket[] = [...counts.entries()]
    .map(([id, v]) => ({ id, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count);

  return { traders: classified.slice(0, topN), distribution, total: classified.length };
}

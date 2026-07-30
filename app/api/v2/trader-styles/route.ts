/**
 * /api/v2/trader-styles — the Analytics "Trader styles" roster.
 *
 * The beta indexer has no global order stream, so — exactly like the leaderboard —
 * we reconstruct the roster by fanning `/markets/:id/orders` across EVERY market
 * the indexer still retains (its `/markets` caps at ~500 rows, ~8h on a
 * minute-rolling venue: that IS the full retained universe). Every wallet that
 * traded in that window is classified by how it bet (classifyV2Traders).
 *
 * Doing this server-side keeps the browser to ONE request instead of 500, and the
 * in-process cache (2-min TTL + single-flight) means bursty traffic never re-fans.
 * Degrades to `{ available:false }` with an empty roster on a hard failure.
 *
 * INTERIM: this is the last-8h retained window, the same ceiling as the
 * leaderboard. A complete all-time roster needs the indexer's account-list
 * endpoint (still 404, expected live soon) — swap the fan-out for that when it
 * lands; the response shape here stays the same.
 */
import { NextResponse } from 'next/server';
import { getV2Markets, getMarketOrders } from '@/lib/api/v2/client';
import { mapPool, withRetry } from '@/lib/api/v2/fan-out';
import { classifyV2Traders } from '@/lib/analytics/v2-trader-style';
import type { V2TraderStyles } from '@/lib/analytics/v2-trader-style';
import type { V2Market, V2OrderEvent } from '@/lib/api/v2/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** The indexer's own ceiling on `/markets` — the full retained roster. */
const MARKET_LIMIT = 500;
/** Per-market order cap — high so the busiest markets' traders aren't truncated. */
const ORDERS_PER_MARKET = 500;
/** In-flight order fetches. Server-to-server, so no browser socket cap applies. */
const CONCURRENCY = 20;
/** Cache TTL — a "how traders bet" view moves slowly, so 2 min is plenty fresh. */
const TTL_MS = 120_000;

export interface V2StylesRoster extends V2TraderStyles {
  available: boolean;
  asOf: number;
}

const EMPTY = (): V2StylesRoster => ({ available: false, asOf: Date.now(), traders: [], distribution: [], total: 0 });

async function build(): Promise<V2StylesRoster> {
  const asOf = Date.now();

  // 1. The full retained market roster, deduped by id (newest instance wins).
  const raw = await getV2Markets(MARKET_LIMIT);
  const byId = new Map<string, V2Market>();
  for (const m of raw) {
    const prev = byId.get(m.expiry_market_id);
    if (!prev || m.checkpoint_timestamp_ms > prev.checkpoint_timestamp_ms) byId.set(m.expiry_market_id, m);
  }
  const ids = [...byId.keys()];

  // 2. Fan the per-market order feeds out (bounded); a single failing feed is skipped.
  const byMarket = new Map<string, V2OrderEvent[]>();
  await mapPool(ids, CONCURRENCY, async (id) => {
    try {
      byMarket.set(id, await withRetry(() => getMarketOrders(id, ORDERS_PER_MARKET)));
    } catch {
      /* skip a genuinely-unavailable market feed */
    }
  });

  // 3. Classify every wallet by how it bet across the retained window.
  const styles = classifyV2Traders(byMarket);
  return { available: true, asOf, ...styles };
}

// In-process cache + single-flight, so bursty traffic never re-fans the 500-market scan.
const g = globalThis as unknown as {
  __v2Styles?: { at: number; payload: V2StylesRoster };
  __v2StylesInflight?: Promise<V2StylesRoster> | null;
};

export async function GET() {
  const now = Date.now();
  if (g.__v2Styles && now - g.__v2Styles.at < TTL_MS) {
    return NextResponse.json(g.__v2Styles.payload);
  }
  try {
    if (!g.__v2StylesInflight) {
      g.__v2StylesInflight = build().finally(() => {
        g.__v2StylesInflight = null;
      });
    }
    const payload = await g.__v2StylesInflight;
    g.__v2Styles = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    if (g.__v2Styles) return NextResponse.json(g.__v2Styles.payload);
    return NextResponse.json(EMPTY());
  }
}

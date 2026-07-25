/**
 * /api/insights/btc/positioning — the options/flow positioning behind the surface's
 * odds, for the BTC Options page's "Positioning & flow" strip.
 *
 * Fans out four Clawby PRO interfaces in parallel and normalizes to a tiny payload:
 *   - option_max_pain (Deribit)                → max-pain + put/call OI per expiry
 *   - option_info                              → total OI, Deribit dominance, 24h vol
 *   - etf_bitcoin_flow_history                 → latest daily spot-ETF net flow
 *   - futures_global_long_short_account_ratio  → crowd long/short
 *
 * SERVER-ONLY (the Clawby key is a per-account secret): holds the key via the
 * clawby-server helper, caches in-process (60s TTL + single-flight) so bursty
 * traffic can't hammer Clawby, and degrades to `{ available:false }` with no key.
 */
import { NextResponse } from 'next/server';
import type { Positioning, ExpiryPositioning } from '@/lib/insights/positioning';
import { relay, asList, toNum, parseYymmdd, hasClawbyKey } from '@/lib/insights/clawby-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 60_000;

async function build(): Promise<Positioning> {
  const base: Positioning = {
    available: true,
    asOf: Date.now(),
    maxPain: [],
    options: null,
    etfFlow: null,
    crowd: null,
    pressure: null,
    smartMoney: null,
  };

  const [mp, info, etf, ls, pr, top] = await Promise.allSettled([
    relay('option_max_pain', { symbol: 'BTC', exchange: 'Deribit' }),
    relay('option_info', { symbol: 'BTC' }),
    relay('etf_bitcoin_flow_history', {}),
    relay('futures_global_long_short_account_ratio_history', { exchange: 'Binance', symbol: 'BTCUSDT', interval: '1h', limit: 1 }),
    relay('futures_taker_buy_sell_volume_exchange_list', { symbol: 'BTC', range: '1h' }),
    relay('futures_top_long_short_account_ratio_history', { exchange: 'Binance', symbol: 'BTCUSDT', interval: '1h', limit: 1 }),
  ]);

  if (mp.status === 'fulfilled') {
    base.maxPain = asList(mp.value)
      .map((r): ExpiryPositioning | null => {
        const maxPainPrice = toNum(r.max_pain_price);
        if (maxPainPrice == null) return null;
        const callOi = toNum(r.call_open_interest) ?? 0;
        const putOi = toNum(r.put_open_interest) ?? 0;
        return { date: parseYymmdd(r.date), maxPainPrice, callOi, putOi, putCallRatio: callOi > 0 ? putOi / callOi : 0 };
      })
      .filter((x): x is ExpiryPositioning => x != null)
      .slice(0, 4);
  }

  if (info.status === 'fulfilled') {
    const rows = asList(info.value);
    const all = rows.find((r) => String(r.exchange_name) === 'All');
    const deribit = rows.find((r) => String(r.exchange_name) === 'Deribit');
    if (all) {
      base.options = {
        totalOiUsd: toNum(all.open_interest_usd),
        deribitSharePct: deribit ? toNum(deribit.oi_market_share) : null,
        volume24hUsd: toNum(all.volume_usd_24h),
      };
    }
  }

  if (etf.status === 'fulfilled') {
    const rows = asList(etf.value);
    const last = rows[rows.length - 1]; // chronological → newest is last
    if (last) {
      const byFund = asList(last.etf_flows)
        .map((f) => ({ ticker: String(f.etf_ticker ?? ''), flowUsd: toNum(f.flow_usd) ?? 0 }))
        .filter((f) => f.flowUsd !== 0)
        .sort((a, b) => Math.abs(b.flowUsd) - Math.abs(a.flowUsd))
        .slice(0, 3);
      const ts = toNum(last.timestamp);
      base.etfFlow = {
        netUsd: toNum(last.flow_usd) ?? 0,
        asOfDate: ts != null ? new Date(ts).toISOString().slice(0, 10) : '',
        byFund,
      };
    }
  }

  if (ls.status === 'fulfilled') {
    const rows = asList(ls.value);
    const last = rows[rows.length - 1];
    if (last) {
      const longPct = toNum(last.global_account_long_percent);
      const shortPct = toNum(last.global_account_short_percent);
      if (longPct != null && shortPct != null) base.crowd = { longPct, shortPct };
    }
  }

  if (pr.status === 'fulfilled' && pr.value && typeof pr.value === 'object') {
    const o = pr.value as Record<string, unknown>;
    const buyPct = toNum(o.buy_ratio);
    const sellPct = toNum(o.sell_ratio);
    if (buyPct != null && sellPct != null) base.pressure = { buyPct, sellPct };
  }

  if (top.status === 'fulfilled') {
    const rows = asList(top.value);
    const last = rows[rows.length - 1];
    if (last) {
      const topLongPct = toNum(last.top_account_long_percent);
      const topShortPct = toNum(last.top_account_short_percent);
      if (topLongPct != null && topShortPct != null) base.smartMoney = { topLongPct, topShortPct };
    }
  }

  return base;
}

// In-process cache + single-flight, so bursty traffic never fans out to Clawby.
const g = globalThis as unknown as {
  __btcPositioning?: { at: number; payload: Positioning };
  __btcPosInflight?: Promise<Positioning> | null;
};

export async function GET() {
  if (!hasClawbyKey()) {
    return NextResponse.json({ available: false } satisfies Partial<Positioning>);
  }
  const now = Date.now();
  if (g.__btcPositioning && now - g.__btcPositioning.at < TTL_MS) {
    return NextResponse.json(g.__btcPositioning.payload);
  }
  try {
    if (!g.__btcPosInflight) {
      g.__btcPosInflight = build().finally(() => {
        g.__btcPosInflight = null;
      });
    }
    const payload = await g.__btcPosInflight;
    g.__btcPositioning = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    if (g.__btcPositioning) return NextResponse.json(g.__btcPositioning.payload);
    return NextResponse.json({ available: false } satisfies Partial<Positioning>);
  }
}

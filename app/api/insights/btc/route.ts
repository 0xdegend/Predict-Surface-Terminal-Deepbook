/**
 * /api/insights/btc — live BTC market context for the surface's right-rail card.
 *
 * The surface prices the FAIR probability of a strike (from the SVI vol); this
 * route adds the wider-market context a trader reads that probability against —
 * spot, funding regime, open interest, 24h liquidations, options max-pain, and
 * sentiment — sourced from Clawby (openclawby.com).
 *
 * SERVER-ONLY: the Clawby key is a per-account secret and the API is rate-limited
 * + metered, so the browser must never call it. This route holds the key
 * (`CLAWBY_API_KEY`), fans the interfaces out in parallel, normalizes to a tiny
 * payload, and caches it in-process (60s TTL) so traffic can't hammer Clawby.
 * Degrades gracefully to `{ available: false }` when no key is configured.
 */
import { NextResponse } from 'next/server';
import type { MarketContext } from '@/lib/insights/context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAWBY = 'https://api.openclawby.com/api/relay';
const KEY = process.env.CLAWBY_API_KEY;
const TTL_MS = 60_000;

const n = (v: unknown): number | null => {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
};

/** Unwrap the CoinGlass envelope `{code, data}` that Clawby relays return. */
function unwrap(data: unknown): unknown {
  if (data && typeof data === 'object' && 'data' in (data as Record<string, unknown>) && 'code' in (data as Record<string, unknown>)) {
    return (data as { data: unknown }).data;
  }
  return data;
}

async function relay(name: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const res = await fetch(CLAWBY, {
    method: 'POST',
    headers: { 'X-API-Key': KEY as string, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, params }),
    // The route owns caching; don't let fetch cache a stale sweep.
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`clawby ${name} → ${res.status}`);
  const json = (await res.json()) as { data?: unknown };
  return unwrap(json.data);
}

const asList = (v: unknown): Record<string, unknown>[] => {
  const u = unwrap(v);
  return Array.isArray(u) ? (u as Record<string, unknown>[]) : [];
};
const findBtc = (rows: Record<string, unknown>[]): Record<string, unknown> | undefined =>
  rows.find((r) => {
    const s = String(r.symbol ?? r.coin ?? '').toUpperCase();
    return s === 'BTC' || s === 'BTCUSDT' || s === 'XBT';
  });

function sentimentLabel(v: number): string {
  return v < 25 ? 'Extreme Fear' : v < 45 ? 'Fear' : v < 55 ? 'Neutral' : v < 75 ? 'Greed' : 'Extreme Greed';
}

/** '260721' (YYMMDD) → '2026-07-21'. */
function parseExpiry(d: unknown): string {
  const s = String(d ?? '');
  return /^\d{6}$/.test(s) ? `20${s.slice(0, 2)}-${s.slice(2, 4)}-${s.slice(4, 6)}` : s;
}

async function build(): Promise<MarketContext> {
  const base: MarketContext = {
    available: true,
    asOf: Date.now(),
    spot: null,
    change24hPct: null,
    oiUsd: null,
    funding: { binancePct: null, avgPct: null },
    liq24h: { totalUsd: null, longUsd: null, shortUsd: null },
    maxPain: null,
    sentiment: null,
  };

  // Fan out; any single source failing must not sink the card.
  const [markets, funding, liq, fear, maxPain] = await Promise.allSettled([
    relay('futures_coins_markets'),
    relay('futures_funding_rate_exchange_list'),
    relay('futures_liquidation_coin_list', { exchange: 'Binance' }),
    relay('index_fear_greed_history', { limit: 1 }),
    relay('option_max_pain', { symbol: 'BTC', exchange: 'Deribit' }),
  ]);

  if (markets.status === 'fulfilled') {
    const b = findBtc(asList(markets.value));
    if (b) {
      base.spot = n(b.current_price ?? b.price);
      base.change24hPct = n(b.price_change_percent_24h);
      base.oiUsd = n(b.open_interest_usd ?? b.open_interest);
    }
  }

  if (funding.status === 'fulfilled') {
    const b = findBtc(asList(funding.value));
    const list = (b?.stablecoin_margin_list ?? b?.uMarginList) as Record<string, unknown>[] | undefined;
    if (Array.isArray(list) && list.length) {
      const rates = list.map((e) => n(e.funding_rate)).filter((x): x is number => x != null);
      base.funding.avgPct = rates.length ? rates.reduce((a, c) => a + c, 0) / rates.length : null;
      const bin = list.find((e) => String(e.exchange) === 'Binance');
      base.funding.binancePct = bin ? n(bin.funding_rate) : base.funding.avgPct;
    }
  }

  if (liq.status === 'fulfilled') {
    const b = findBtc(asList(liq.value));
    if (b) {
      base.liq24h = {
        totalUsd: n(b.liquidation_usd_24h),
        longUsd: n(b.long_liquidation_usd_24h),
        shortUsd: n(b.short_liquidation_usd_24h),
      };
    }
  }

  if (fear.status === 'fulfilled') {
    const d = unwrap(fear.value) as { data_list?: unknown[] } | undefined;
    const arr = d?.data_list;
    if (Array.isArray(arr) && arr.length) {
      const v = n(arr[arr.length - 1]); // chronological → newest is last
      if (v != null) base.sentiment = { value: Math.round(v), label: sentimentLabel(v) };
    }
  }

  if (maxPain.status === 'fulfilled') {
    const rows = asList(maxPain.value);
    if (rows.length) {
      const strike = n(rows[0].max_pain_price);
      if (strike != null) base.maxPain = { strike, date: parseExpiry(rows[0].date) };
    }
  }

  return base;
}

// In-process cache + single-flight, so bursty traffic never fans out to Clawby.
const g = globalThis as unknown as { __btcInsights?: { at: number; payload: MarketContext }; __btcInflight?: Promise<MarketContext> | null };

export async function GET() {
  if (!KEY) {
    return NextResponse.json({ available: false } satisfies Partial<MarketContext>);
  }
  const now = Date.now();
  if (g.__btcInsights && now - g.__btcInsights.at < TTL_MS) {
    return NextResponse.json(g.__btcInsights.payload);
  }
  try {
    if (!g.__btcInflight) {
      g.__btcInflight = build().finally(() => {
        g.__btcInflight = null;
      });
    }
    const payload = await g.__btcInflight;
    g.__btcInsights = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    // Serve the last good payload if we have one; else signal unavailable.
    if (g.__btcInsights) return NextResponse.json(g.__btcInsights.payload);
    return NextResponse.json({ available: false } satisfies Partial<MarketContext>);
  }
}

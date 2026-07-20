/**
 * /api/insights/btc/candles — recent 1-minute BTC closes, the raw material for
 * the strike-analysis panel.
 *
 * Why a tape and not a per-strike endpoint: the analysis a trader wants ("how
 * often has BTC actually moved this far in the time I have left?") is a function
 * of the SAME candle history for every strike. So we fetch the tape once, cache
 * it, and let the client re-derive the answer for any strike with zero further
 * calls — dragging the strike slider costs nothing, and Clawby sees at most one
 * request a minute no matter how many traders or how much they fiddle.
 *
 * SERVER-ONLY, same rules as ../route.ts: the Clawby key never reaches the
 * browser, and the in-process cache + single-flight keep a burst of traffic to a
 * single upstream call.
 */
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLAWBY = 'https://api.openclawby.com/api/relay';
const KEY = process.env.CLAWBY_API_KEY;
const TTL_MS = 60_000;
/** 2000 × 1m ≈ 33h — verified live as the max the interface returns in one call. */
const BARS = 2000;

export interface BtcCandles {
  available: boolean;
  asOf: number;
  intervalMs: number;
  /** Bar open times (ms), oldest → newest. */
  times: number[];
  /** Close prices, index-aligned with `times`. */
  closes: number[];
}

async function build(): Promise<BtcCandles> {
  const res = await fetch(CLAWBY, {
    method: 'POST',
    headers: { 'X-API-Key': KEY as string, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'futures_price_history',
      // `limit` is required on this interface, and `symbol` wants PAIR form
      // (BTCUSDT) — the coin form (BTC) that the aggregate endpoints take
      // errors here with "pair does not exist".
      params: { exchange: 'Binance', symbol: 'BTCUSDT', interval: '1m', limit: BARS },
    }),
    cache: 'no-store',
  });
  if (!res.ok) throw new Error(`clawby candles → ${res.status}`);

  // Double envelope: the relay wraps its payload, and CoinGlass wraps that.
  const json = (await res.json()) as { data?: { code?: string; data?: unknown } };
  const rows = json.data?.data;
  if (!Array.isArray(rows)) throw new Error('clawby candles → unexpected shape');

  const times: number[] = [];
  const closes: number[] = [];
  for (const r of rows as Record<string, unknown>[]) {
    const t = Number(r.time);
    const c = Number(r.close); // strings on the wire
    if (Number.isFinite(t) && Number.isFinite(c) && c > 0) {
      times.push(t);
      closes.push(c);
    }
  }
  // Oldest → newest, so window scans read forward in time.
  if (times.length > 1 && times[0] > times[times.length - 1]) {
    times.reverse();
    closes.reverse();
  }

  return { available: closes.length > 0, asOf: Date.now(), intervalMs: 60_000, times, closes };
}

const g = globalThis as unknown as {
  __btcCandles?: { at: number; payload: BtcCandles };
  __btcCandlesInflight?: Promise<BtcCandles> | null;
};

const EMPTY: BtcCandles = { available: false, asOf: 0, intervalMs: 60_000, times: [], closes: [] };

export async function GET() {
  if (!KEY) return NextResponse.json(EMPTY);

  const now = Date.now();
  if (g.__btcCandles && now - g.__btcCandles.at < TTL_MS) {
    return NextResponse.json(g.__btcCandles.payload);
  }
  try {
    if (!g.__btcCandlesInflight) {
      g.__btcCandlesInflight = build().finally(() => {
        g.__btcCandlesInflight = null;
      });
    }
    const payload = await g.__btcCandlesInflight;
    g.__btcCandles = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    // A stale tape still answers the question well — 33h of history barely
    // changes minute to minute. Only give up if we've never had one.
    if (g.__btcCandles) return NextResponse.json(g.__btcCandles.payload);
    return NextResponse.json(EMPTY);
  }
}

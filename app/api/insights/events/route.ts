/**
 * /api/insights/events — the market-moving CALENDAR for Kelly (today + ahead).
 *
 * Pulls the macro schedule via Clawby `calendar_economic_data` (a Fed decision,
 * CPI, jobs) from the top of today through the next ~month, keeps the notable rows
 * (importance 3), and tacks on the top crypto news headline via `article_list`.
 * Returns two views off that one fetch: `events` (today only, importance-first —
 * the greeting + "what's happening today?" reply) and `upcoming` (today → +~month,
 * chronological — the "events this week / this month?" reply).
 *
 * SERVER-ONLY (the Clawby key is a per-account secret). Cached in-process (20-min
 * TTL + single-flight, since a calendar barely moves intraday), degrades to
 * `{ available:false }` with no key / on error.
 */
import { NextResponse } from 'next/server';
import type { EventsFeed, MarketEvent } from '@/lib/insights/events';
import { NOTABLE_IMPORTANCE, prettyTitle, startOfUtcDay } from '@/lib/insights/events';
import { relay, asList, hasClawbyKey, toNum } from '@/lib/insights/clawby-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 1_200_000; // 20 minutes — a calendar barely changes intraday.
const DAY_MS = 86_400_000;
// Cross-midnight floor: always look at least this far back, so a release just
// before midnight still reads as "recent" right after the date rolls over.
const WINDOW_BACK_MS = 6 * 3_600_000;
// Look a month + a little slack ahead, so "this week" and "this month" have data.
const WINDOW_FWD_DAYS = 35;
const MAX_EVENTS = 6; // today's lineup
const MAX_UPCOMING = 40; // the month-ahead lineup (grouped by day downstream)

/** Trimmed string, or null for empty / missing. */
function str(v: unknown): string | null {
  const s = (v ?? '').toString().trim();
  return s.length ? s : null;
}

/** US events rank first — a BTC audience reacts most to US macro (the Fed, CPI,
 *  PCE, jobs). 0 = US, 1 = everyone else. */
function usRank(e: MarketEvent): number {
  return /^(?:us|usa|united states)$/i.test((e.country ?? '').trim()) ? 0 : 1;
}

/** A normalized key to collapse near-identical prints (the same release reported
 *  as QoQ/YoY/seasonally-adjusted etc.), so one family doesn't fill the list. */
function dedupeKey(e: MarketEvent): string {
  return `${(e.country ?? '').toLowerCase()}|${e.title
    .toLowerCase()
    .replace(/\([^)]*\)/g, '') // drop "(MoM)", "(Q2)", "(Preliminary)"
    .replace(/\b(seasonally|unseasonally|adjusted|preliminary|final|flash|core|headline)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim()}`;
}

/** Map one raw calendar row to a normalized MarketEvent (or null if unusable). */
function toEvent(row: Record<string, unknown>, now: number): MarketEvent | null {
  const raw = str(row.calendar_name);
  if (!raw) return null;
  const title = prettyTitle(raw);
  const importance = toNum(row.importance_level) ?? 0;
  // Only trust the timestamp as a precise time when the feed says it's exact;
  // otherwise the coarse relative phrasing leans on the released flag alone.
  const exact = toNum(row.has_exact_publish_time) === 1;
  const ts = toNum(row.publish_timestamp);
  const at = exact && ts != null ? ts : null;
  // The DAY is kept even when the exact time isn't, so a future release can still
  // be placed on the calendar ("this week" / "this month").
  const date = ts != null ? startOfUtcDay(ts) : null;
  const actual = str(row.published_value);
  const released = actual != null || (ts != null && ts <= now);
  return {
    title,
    country: str(row.country_name) ?? str(row.country_code),
    importance,
    at,
    date,
    released,
    forecast: str(row.forecast_value),
    previous: str(row.previous_value) ?? str(row.revised_previous_value),
    actual,
    effect: str(row.data_effect),
  };
}

async function fetchHeadline(): Promise<string | null> {
  try {
    const arts = asList(await relay('article_list', { per_page: 3, language: 'en' }));
    return str(arts[0]?.article_title);
  } catch {
    return null; // the calendar still stands on its own.
  }
}

async function build(): Promise<EventsFeed> {
  const asOf = Date.now();
  const todayStart = startOfUtcDay(asOf);
  let events: MarketEvent[] = [];
  let upcoming: MarketEvent[] = [];
  let calendarOk = false; // did the calendar actually load? (an empty day ≠ a failed fetch)

  try {
    // Top of today (UTC) plus a cross-midnight floor for the lookback, through a
    // month ahead for the upcoming view — one fetch feeds both.
    const start_time = Math.min(todayStart, asOf - WINDOW_BACK_MS);
    const rows = asList(
      await relay('calendar_economic_data', {
        start_time,
        end_time: todayStart + WINDOW_FWD_DAYS * DAY_MS,
        language: 'en',
      }),
    );
    const notable = rows
      .map((r) => toEvent(r, asOf))
      .filter((e): e is MarketEvent => e != null && e.importance >= NOTABLE_IMPORTANCE);

    // Today's lineup: importance-first (unchanged), collapsing same-day variants.
    const seenToday = new Set<string>();
    events = notable
      .filter((e) => e.date != null && e.date >= todayStart && e.date < todayStart + DAY_MS)
      .sort((a, b) => b.importance - a.importance || usRank(a) - usRank(b) || (a.at ?? Infinity) - (b.at ?? Infinity))
      .filter((e) => (seenToday.has(dedupeKey(e)) ? false : (seenToday.add(dedupeKey(e)), true)))
      .slice(0, MAX_EVENTS);

    // The upcoming calendar: today → +month, chronological. Dedupe keys the DAY in
    // too, so a monthly release recurring on different days stays (only same-day
    // QoQ/YoY variants collapse).
    const seenUp = new Set<string>();
    upcoming = notable
      .filter((e) => e.date != null)
      .sort((a, b) => a.date! - b.date! || b.importance - a.importance || usRank(a) - usRank(b) || (a.at ?? Infinity) - (b.at ?? Infinity))
      .filter((e) => {
        const k = `${dedupeKey(e)}|${e.date}`;
        return seenUp.has(k) ? false : (seenUp.add(k), true);
      })
      .slice(0, MAX_UPCOMING);
    calendarOk = true; // the relay answered — an empty list here is a genuinely quiet day
  } catch {
    // The calendar source is unreachable (e.g. Clawby upstream 502). Leave the
    // lists empty AND mark the feed unavailable below, so we never pass an outage
    // off as "nothing scheduled today".
    events = [];
    upcoming = [];
  }

  const headline = await fetchHeadline();
  // `available` means "we could read the calendar". A real but empty day stays
  // available (Kelly says "nothing major today"); a failed fetch is unavailable
  // (Kelly says "can't pull the calendar right now"), matching the fast-retry
  // contract in useMarketEvents.
  return { available: calendarOk, asOf, events, upcoming, headline };
}

// In-process cache + single-flight, so bursty traffic never fans out to Clawby.
const g = globalThis as unknown as {
  __mktEvents?: { at: number; payload: EventsFeed };
  __mktEventsInflight?: Promise<EventsFeed> | null;
};

export async function GET() {
  if (!hasClawbyKey()) {
    return NextResponse.json({ available: false } satisfies Partial<EventsFeed>);
  }
  const now = Date.now();
  // Only healthy payloads are ever cached (below), so this fast-path can never
  // serve a stale "unavailable" and stall the client's 60s retry.
  if (g.__mktEvents && now - g.__mktEvents.at < TTL_MS) {
    return NextResponse.json(g.__mktEvents.payload);
  }
  try {
    if (!g.__mktEventsInflight) {
      g.__mktEventsInflight = build().finally(() => {
        g.__mktEventsInflight = null;
      });
    }
    const payload = await g.__mktEventsInflight;
    // Cache good calendars only. A real fetch (even an empty quiet day) refreshes
    // the 20-min window; a failed fetch is returned as-is (available:false) and is
    // NOT cached, so the last good entry simply ages out of the fast-path above and
    // Kelly falls back to an honest "can't pull the calendar", not a stale one.
    if (payload.available) g.__mktEvents = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    if (g.__mktEvents) return NextResponse.json(g.__mktEvents.payload);
    return NextResponse.json({ available: false } satisfies Partial<EventsFeed>);
  }
}

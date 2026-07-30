/**
 * /api/insights/events — today's market-moving CALENDAR for Kelly.
 *
 * Pulls the macro schedule via Clawby `calendar_economic_data` (a Fed decision,
 * CPI, jobs) over a window around "now", keeps the notable rows (importance 2+),
 * and tacks on the top crypto news headline via `article_list`. Feeds both the
 * co-pilot's "what's happening today?" answer and Kelly's greeting heads-up.
 *
 * SERVER-ONLY (the Clawby key is a per-account secret). Cached in-process (20-min
 * TTL + single-flight, since a calendar barely moves intraday), degrades to
 * `{ available:false }` with no key / on error.
 */
import { NextResponse } from 'next/server';
import type { EventsFeed, MarketEvent } from '@/lib/insights/events';
import { NOTABLE_IMPORTANCE, prettyTitle } from '@/lib/insights/events';
import { relay, asList, hasClawbyKey, toNum } from '@/lib/insights/clawby-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 1_200_000; // 20 minutes — a calendar barely changes intraday.
const WINDOW_BACK_MS = 6 * 3_600_000; // include events that just released
const WINDOW_FWD_MS = 24 * 3_600_000; // through the rest of today + a little slack
const MAX_EVENTS = 6;

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
  const actual = str(row.published_value);
  const released = actual != null || (ts != null && ts <= now);
  return {
    title,
    country: str(row.country_name) ?? str(row.country_code),
    importance,
    at,
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
  let events: MarketEvent[] = [];

  try {
    const rows = asList(
      await relay('calendar_economic_data', {
        start_time: asOf - WINDOW_BACK_MS,
        end_time: asOf + WINDOW_FWD_MS,
        language: 'en',
      }),
    );
    const ranked = rows
      .map((r) => toEvent(r, asOf))
      .filter((e): e is MarketEvent => e != null && e.importance >= NOTABLE_IMPORTANCE)
      // Most important first, then US events, then soonest (unknown times last).
      .sort(
        (a, b) =>
          b.importance - a.importance || usRank(a) - usRank(b) || (a.at ?? Infinity) - (b.at ?? Infinity),
      );
    // Collapse near-identical prints, keeping the highest-ranked instance.
    const seen = new Set<string>();
    events = ranked.filter((e) => (seen.has(dedupeKey(e)) ? false : (seen.add(dedupeKey(e)), true))).slice(0, MAX_EVENTS);
  } catch {
    events = []; // no calendar → still return an (empty) available feed.
  }

  const headline = await fetchHeadline();
  return { available: true, asOf, events, headline };
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
    g.__mktEvents = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    if (g.__mktEvents) return NextResponse.json(g.__mktEvents.payload);
    return NextResponse.json({ available: false } satisfies Partial<EventsFeed>);
  }
}

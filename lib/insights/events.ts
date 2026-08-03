/**
 * lib/insights/events.ts — today's market-moving CALENDAR, in plain language.
 *
 * Answers "what's happening today?" and feeds Kelly's greeting with a heads-up
 * about the day's big scheduled events (a Fed rate decision, CPI, jobs). PURE +
 * tested + jargon-free, the same discipline as narrative / market-read.
 *
 * Data comes from Clawby's `calendar_economic_data` (macro schedule) + a crypto
 * news headline (`article_list`), fetched + shaped server-side (see the
 * /api/insights/events route). This module holds the shared shapes and the
 * plain-language builders both the co-pilot reply and the greeting use.
 *
 * Honesty rules, baked in:
 *  - We report the SCHEDULE, never a prediction of the outcome or the market's
 *    reaction. "This is on the calendar", not "this will pump BTC".
 *  - Times are RELATIVE and coarse ("in about 3 hours", "earlier today") so a
 *    timezone or a slightly stale clock can never make us state a wrong wall time.
 */

/** One scheduled economic event (a calendar row), normalized + de-noised. */
export interface MarketEvent {
  /** Plain title, e.g. "Fed Interest Rate Decision". */
  title: string;
  /** Country/region label, e.g. "US". Null when the feed omits it. */
  country: string | null;
  /** 1 = minor, higher = bigger. We surface 2+ only; 3+ reads as "a big one". */
  importance: number;
  /** Scheduled publish time (ms). Null when the feed has no exact time. */
  at: number | null;
  /** The scheduled DAY (UTC midnight, ms). Present even when the exact time isn't,
   *  so future events can be placed on the calendar ("this week" / "this month").
   *  Null only when the feed carries no timestamp at all. */
  date?: number | null;
  /** True once the number is out (actual published, or its time has passed). */
  released: boolean;
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  /** The feed's own directional note, e.g. "bearish for the US dollar". */
  effect: string | null;
}

/** The payload the /api/insights/events route returns. */
export interface EventsFeed {
  available: boolean;
  asOf: number;
  /** Today's notable events (importance 2+), most important first, then soonest. */
  events: MarketEvent[];
  /** The notable calendar from today through the next ~month, in CHRONOLOGICAL
   *  order — drives the "events this week / this month" answer. A superset of
   *  `events` (which stays today-only so the greeting + today reply don't change).
   *  Optional so older/mocked feeds without it still type-check. */
  upcoming?: MarketEvent[];
  /** Top crypto news headline (plain title only), or null. */
  headline: string | null;
}

/** How far ahead the "upcoming events" answer looks. */
export type EventHorizon = 'week' | 'month';

/** Plain-language names for the common (noisy, jargon-y) calendar titles — the
 *  raw feed says "Personal consumption expenditure price index (MoM)(Jun)". First
 *  match wins, so order specific → generic. The country is added separately, so
 *  these stay country-free ("interest rate decision" → "US interest rate
 *  decision"). Unmatched titles fall back to a parentheses-stripped version. */
const TITLE_MAP: [RegExp, string][] = [
  [/federal funds|fed funds|overnight target|official bank rate|\bbank rate\b|policy rate|rate decision|interest rate/i, 'interest rate decision'],
  [/consumer price index|\bcpi\b/i, 'CPI inflation'],
  [/producer price index|\bppi\b/i, 'PPI inflation'],
  [/personal consumption expenditure price index|\bpce\b.*price|core pce/i, 'PCE inflation'],
  [/personal consumption expenditure|consumer spending/i, 'consumer spending'],
  [/nonfarm payroll|non-farm payroll|\bnfp\b/i, 'jobs report'],
  [/initial\b.*claims|jobless claims/i, 'jobless claims'],
  [/unemployment rate/i, 'unemployment rate'],
  [/gross domestic product|\bgdp\b/i, 'GDP'],
  [/personal income/i, 'personal income'],
  [/retail sales/i, 'retail sales'],
];

/** Turn a raw calendar title into plain, jargon-free language: map the common
 *  releases to friendly names, else strip the "(MoM)(Jun)(Preliminary)" clutter. */
export function prettyTitle(raw: string): string {
  const stripped = raw.replace(/\([^)]*\)/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [re, name] of TITLE_MAP) if (re.test(stripped)) return name;
  return stripped;
}

/** Importance at/above which an event is worth a greeting heads-up + the reply.
 *  Calibrated to live data: level 1-2 is routine (retail sales, confidence
 *  indices), level 3 is the high-impact set (a rate decision, CPI, PCE, jobs,
 *  GDP) BTC actually reacts to. So we surface level 3 only. */
export const NOTABLE_IMPORTANCE = 3;

/** Notable (high-impact) events only, already filtered + ordered by the route. */
export function notableEvents(feed: EventsFeed | null): MarketEvent[] {
  if (!feed?.available) return [];
  return feed.events.filter((e) => e.importance >= NOTABLE_IMPORTANCE);
}

/** The single most notable event today (for the greeting), or null. */
export function topEvent(feed: EventsFeed | null): MarketEvent | null {
  return notableEvents(feed)[0] ?? null;
}

/** The event's scheduled time as a UTC clock label, e.g. "13:30 UTC". Only valid
 *  when the event has an exact time (`at != null`); UTC keeps it unambiguous for a
 *  global audience and dodges any local-timezone drift. */
export function utcTime(ms: number): string {
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

/** A coarse, timezone-safe relative time for an event vs `now`. */
export function relTime(evt: MarketEvent, now: number): string {
  if (evt.released || (evt.at != null && evt.at <= now)) {
    if (evt.at != null && now - evt.at <= 2 * 3_600_000) return 'in the last couple of hours';
    return 'earlier today';
  }
  if (evt.at == null) return 'later today';
  const diffMs = evt.at - now;
  if (diffMs > 24 * 3_600_000) return 'tomorrow';
  if (diffMs <= 90 * 60_000) return 'within the hour';
  const hours = Math.round(diffMs / 3_600_000);
  return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
}

/** How to name an event in a sentence: title, with the country prefixed when the
 *  title doesn't already carry it (so "Fed Interest Rate Decision" stays as-is but
 *  a bare "Jobless Claims" becomes "US Jobless Claims"). */
export function eventName(evt: MarketEvent): string {
  const t = evt.title.trim();
  if (!evt.country) return t;
  const c = evt.country.trim();
  // Whole-word match (not substring), so a country like "US" doesn't read as
  // already present inside a word like "trust".
  const present = new RegExp(`\\b${c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(t);
  return present ? t : `${c} ${t}`;
}

/**
 * The greeting heads-up line: one short sentence naming the day's biggest event,
 * pointing the user at the full read. No `now` needed (uses only the released
 * flag), so it's safe to build during render. Null when nothing is notable.
 */
export function eventGreetingLine(feed: EventsFeed | null): string | null {
  const evt = topEvent(feed);
  if (!evt) return null;
  const name = eventName(evt);
  const timing = evt.released ? 'already came out today' : 'is on the calendar';
  return `Heads up, a big market event ${timing}: ${name}. Ask me “what’s happening today” for the full read.`;
}

/**
 * The full "what's happening today?" reply, line by line. Rule-based + honest: it
 * lists the notable scheduled events with coarse relative times, adds the top
 * headline when present, and always closes with a "schedule not a prediction"
 * caveat. When the calendar is empty it says so plainly.
 */
export function buildEventsReply(feed: EventsFeed | null, now: number): string[] {
  if (!feed?.available) {
    return ["I can’t pull today’s calendar right now. Give it a moment and ask again."];
  }
  const events = notableEvents(feed);
  const text: string[] = [];

  if (events.length === 0) {
    text.push('Nothing major is on the economic calendar today, so BTC is mostly trading on its own flow rather than a scheduled event.');
    if (feed.headline) text.push(`In the news, the headline doing the rounds is: “${feed.headline}”. That’s what people are reading, not confirmed market impact.`);
    return text;
  }

  const [first, ...rest] = events;
  text.push(`The big one on today’s calendar is ${eventName(first)} (${relTime(first, now)}). Markets can get jumpy around events like this, so moves may be sharper than usual.`);

  const more = rest.slice(0, 3).map((e) => `${eventName(e)} (${relTime(e, now)})`);
  if (more.length) text.push(`Also today: ${more.join(', ')}.`);

  if (feed.headline) text.push(`In the news, the headline doing the rounds is: “${feed.headline}”.`);

  text.push('This is just the schedule, not a prediction of which way price goes. Not financial advice.');
  return text;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Midnight UTC of the day `ms` falls in. Shared by the route (fetch window) and
 *  the upcoming-events grouping, so both agree on where a day starts. */
export function startOfUtcDay(ms: number): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** A plain, timezone-safe day label for a future (or today's) event, relative to
 *  `now`: "today" / "tomorrow", a weekday name within the week ("Tuesday"), then an
 *  unambiguous short date once it's a week or more out ("Wed Aug 12"). Day-granular
 *  and computed in UTC, matching how the calendar times are handled elsewhere. */
export function relDay(dateMs: number, now: number): string {
  const diffDays = Math.round((startOfUtcDay(dateMs) - startOfUtcDay(now)) / DAY_MS);
  if (diffDays <= 0) return 'today';
  if (diffDays === 1) return 'tomorrow';
  const d = new Date(startOfUtcDay(dateMs));
  if (diffDays <= 6) return WEEKDAYS[d.getUTCDay()];
  return `${WEEKDAYS[d.getUTCDay()].slice(0, 3)} ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The notable events falling within the horizon (a rolling 7 days for "week",
 *  ~31 for "month"), starting from the top of today, in chronological order. Reads
 *  the wide `upcoming` list the route builds; empty when the feed has none. */
export function upcomingEvents(feed: EventsFeed | null, now: number, horizon: EventHorizon): MarketEvent[] {
  if (!feed?.available || !feed.upcoming) return [];
  const start = startOfUtcDay(now);
  const end = start + (horizon === 'week' ? 7 : 31) * DAY_MS;
  // Floor at the top of today so a late-yesterday row the route pulled in via its
  // cross-midnight lookback can't slip in and get mislabelled "today".
  return feed.upcoming
    .filter((e) => e.importance >= NOTABLE_IMPORTANCE && e.date != null && e.date >= start && e.date < end)
    .sort((a, b) => a.date! - b.date! || b.importance - a.importance || (a.at ?? Infinity) - (b.at ?? Infinity));
}

/**
 * The "what's on the calendar this week / this month?" reply, line by line. Same
 * honesty discipline as the today reply: it lists the notable scheduled events
 * with a plain day label each, in date order, and always closes with a "schedule
 * not a prediction" caveat. When nothing notable is in the window it says so.
 */
export function buildUpcomingEventsReply(feed: EventsFeed | null, now: number, horizon: EventHorizon): string[] {
  if (!feed?.available) {
    return ['I can’t pull the economic calendar right now. Give it a moment and ask again.'];
  }
  const label = horizon === 'week' ? 'this week' : 'this month';
  const events = upcomingEvents(feed, now, horizon);
  const text: string[] = [];

  if (events.length === 0) {
    text.push(`Nothing major is on the economic calendar ${label}, so BTC is mostly trading on its own flow rather than a scheduled event.`);
    if (feed.headline) text.push(`In the news, the headline doing the rounds is: “${feed.headline}”. That’s what people are reading, not confirmed market impact.`);
    return text;
  }

  const cap = horizon === 'week' ? 8 : 10;
  const shown = events.slice(0, cap);
  text.push(`Here are the big economic events ${label}. Markets can get jumpy around these, so moves may be sharper than usual:`);
  for (const e of shown) text.push(`• ${eventName(e)} (${relDay(e.date ?? e.at ?? now, now)})`);
  if (events.length > shown.length) text.push(`…plus ${events.length - shown.length} more on the calendar.`);

  text.push('This is just the schedule, not a prediction of which way price goes. Not financial advice.');
  return text;
}

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
  /** Top crypto news headline (plain title only), or null. */
  headline: string | null;
}

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

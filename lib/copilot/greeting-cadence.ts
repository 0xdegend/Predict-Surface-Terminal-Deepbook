// Greeting cadence: show the full "Hi, I'm Kelly" onboarding only on the first
// co-pilot landing of the day; on repeat visits the same day, a shorter
// welcome-back stands in its place. The day-stamp is per-wallet and lives in
// localStorage (per-device, which is the right grain for "have I already greeted
// you here today"), and it's SHARED by the full page and the dock so opening the
// dock later the same day won't re-onboard a trader the page already greeted.

const KEY_PREFIX = 'kelly-greet-day';

function dayKey(owner: string | null | undefined): string {
  return owner ? `${KEY_PREFIX}:${owner.toLowerCase()}` : KEY_PREFIX;
}

/** Local calendar day, e.g. "Sun Aug 17 2026". Day-granular on purpose: the
 *  cadence is once a day, and toDateString drops the clock so a 2pm and a 9pm
 *  visit on the same date read as the same day. */
export function localDay(now: Date = new Date()): string {
  return now.toDateString();
}

/** Pure cadence decision. Given the last-seen day-stamp (or null) and today's
 *  day, is this the first visit today? Also hands back the stamp to persist. */
export function decideVisit(
  lastSeenDay: string | null,
  today: string,
): { firstToday: boolean; nextStamp: string } {
  return { firstToday: lastSeenDay !== today, nextStamp: today };
}

/** True the first time this wallet lands on the co-pilot today; false on repeat
 *  visits the same day. Reads the per-wallet day-stamp and, on a fresh day,
 *  rewrites it to today, so one call both learns and records the visit. On the
 *  server or when storage is unavailable, treat it as a first visit (show the
 *  full intro) and never throw. */
export function firstVisitToday(owner: string | null | undefined, now: Date = new Date()): boolean {
  if (typeof window === 'undefined') return true;
  const key = dayKey(owner);
  const today = localDay(now);
  try {
    const { firstToday, nextStamp } = decideVisit(window.localStorage.getItem(key), today);
    if (firstToday) window.localStorage.setItem(key, nextStamp);
    return firstToday;
  } catch {
    return true;
  }
}

// A device-local snapshot of a trader's resolved greeting — their remembered name and
// whether Kelly has any notes for them — written after a memory recall. On the NEXT
// landing we read it synchronously to paint the right welcome-back BEFORE the async
// recall returns, so navigating back never flashes the long intro and then swaps to the
// short name greeting. Non-sensitive display hint only (the name they told Kelly).

const HINT_PREFIX = 'kelly-greet-hint';

export interface GreetingHint {
  /** The trader's remembered name, or null if unknown. */
  name: string | null;
  /** Whether Kelly has any saved notes for them (drives the name nudge). */
  hasNotes: boolean;
}

function hintKey(owner: string): string {
  return `${HINT_PREFIX}:${owner.toLowerCase()}`;
}

/** The cached greeting hint for this wallet, or null (server / no cache / bad data). */
export function readGreetingHint(owner: string | null | undefined): GreetingHint | null {
  if (!owner || typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(hintKey(owner));
    if (!raw) return null;
    const h = JSON.parse(raw) as Partial<GreetingHint>;
    return { name: typeof h.name === 'string' ? h.name : null, hasNotes: !!h.hasNotes };
  } catch {
    return null;
  }
}

/** Store the resolved greeting hint for this wallet. Never throws. */
export function cacheGreetingHint(owner: string | null | undefined, hint: GreetingHint): void {
  if (!owner || typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(hintKey(owner), JSON.stringify(hint));
  } catch {
    // storage full / unavailable — the async recall path still greets (with one flash)
  }
}

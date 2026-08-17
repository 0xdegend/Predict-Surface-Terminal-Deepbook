/**
 * lib/copilot/memory-greeting.ts — passive continuity.
 *
 * When a RETURNING trader opens Kelly, we recall what Kelly has saved about them and
 * follow the greeting with a short "good to see you back, here's what I remember" bubble.
 * This module holds the pure, capped formatting (the full "what do you remember about me"
 * recall lists everything; the greeting stays light) so it can be unit-tested without the
 * memory API. Used by copilot-screen.tsx and kelly-dock.tsx. See lib/copilot/memory-client.ts
 * for the fetch and lib/walrus/memory.ts for the server-side MemWal wrapper.
 */

/**
 * The recall query for the greeting — deliberately broad, so it surfaces the trader's
 * most defining saved notes (style, preferences, goals) rather than one narrow topic.
 * Shared with the explicit "what do you remember about me?" answer so the two never drift.
 */
export const MEMORY_GREETING_QUERY = 'the trader’s preferences, trading style, goals, and past notes';

/** How many memories the welcome-back bubble shows — kept light for a greeting. */
export const MAX_GREETING_MEMORIES = 3;

/** Third-person-singular preference verbs the notes use, mapped to base form, so a
 *  personalized note never reads "you likes …". Only unambiguous verbs (never common nouns). */
const VERB_BASE: Record<string, string> = {
  leans: 'lean',
  likes: 'like',
  loves: 'love',
  prefers: 'prefer',
  avoids: 'avoid',
  tends: 'tend',
  wants: 'want',
  enjoys: 'enjoy',
  keeps: 'keep',
  uses: 'use',
  favors: 'favor',
  favours: 'favour',
};

/**
 * Rewrite a stored memory so Kelly reads it back TO the trader, in second person:
 *   "This trader likes range bets around FOMC" → "you like range bets around FOMC"
 *   "leans UP and prefers safer bets"          → "you lean UP and prefer safer bets"
 *   "I prefer safer up bets"                   → "you prefer safer up bets"
 * Notes are stored either subjectless + third-person-ish (auto-memory) or first-person (an
 * explicit "remember I …"); either way this makes recall feel personal rather than like a file
 * readout. Leaves an already-second-person or non-preference fact intact (e.g. "your target is
 * 5% a week"). Pure + unit-tested.
 */
export function personalizeMemory(text: string): string {
  let t = text.trim();
  // Drop a third-person subject the note may carry.
  t = t.replace(/^(?:this|the|a)\s+(?:trader|user|person|customer|account)\s+/i, '');
  t = t.replace(/^(?:trader|user)\s+/i, '');
  // Note (before de-conjugation) whether it opens on a subjectless preference verb.
  const firstWord = (t.match(/^([A-Za-z]+)/)?.[1] ?? '').toLowerCase();
  const subjectlessVerb = firstWord in VERB_BASE;
  // First person → second person.
  t = t.replace(/^i\s+/i, 'you ');
  t = t
    .replace(/\bI\b/g, 'you')
    .replace(/\bmy\b/gi, 'your')
    .replace(/\bmine\b/gi, 'yours')
    .replace(/\bmyself\b/gi, 'yourself')
    .replace(/\bme\b/gi, 'you');
  // De-conjugate the known preference verbs so "you" never pairs with an "-s" verb.
  t = t.replace(/\b[A-Za-z]+\b/g, (w) => VERB_BASE[w.toLowerCase()] ?? w);
  // Give a subjectless preference note its "you" subject.
  if (subjectlessVerb && !/^you\b/i.test(t)) t = `you ${t}`;
  return t;
}

/**
 * Build the welcome-back lines from a trader's recalled memories. An empty array means
 * there's nothing worth greeting with (no saved notes) — the caller then shows only the
 * normal greeting, no extra bubble.
 */
export function welcomeBackLines(memories: string[]): string[] {
  const picked = memories
    .map((m) => m.trim())
    .filter((m) => m.length > 0)
    .slice(0, MAX_GREETING_MEMORIES);
  if (picked.length === 0) return [];
  return [
    'Good to see you back. Here’s what I remember about you:',
    ...picked.map((m) => `• ${personalizeMemory(m)}`),
    'Want to pick up from there, or try something new?',
  ];
}

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
export const MEMORY_GREETING_QUERY = 'the trader’s name, preferences, trading style, goals, and past notes';

/** How many memories the greeting recalls — enough to reliably surface a saved name among a
 *  few style notes (the bubble itself now shows one line, not a list). */
export const MAX_GREETING_MEMORIES = 6;

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

/** Pull the trader's remembered name out of their saved notes ("your name is X"), if any. */
export function rememberedName(memories: string[]): string | null {
  for (const m of memories) {
    const match = m.match(/\b(?:your |my )?name(?:['’]s| is)\s+([A-Za-z][\w'’.-]{0,23})/i);
    if (match) return match[1].replace(/[.,!?'’"]+$/, '');
  }
  return null;
}

/** A note that only records the trader's name (so it can be excluded from a style answer). */
function isNameNote(m: string): boolean {
  return /\bname(?:['’]s| is)\b/i.test(m) || /^\s*(?:your|my)\s+name\b/i.test(m);
}

function cap(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/**
 * Build Kelly's reply to a recall question, tailored to what was asked:
 *  - 'name'  → answer it directly ("Your name is Degendev."), or nudge if unknown.
 *  - 'style' → the trader's preferences in second person, minus the bare name note.
 *  - 'general' → "here's what I remember about you" (single sentence, or a bullet list).
 * Pure and unit-tested; both hosts call it so the phrasing lives in one place.
 */
export function recallReplyLines(subject: 'name' | 'style' | 'general', mems: string[]): string[] {
  if (subject === 'name') {
    const name = rememberedName(mems);
    return name
      ? [`Your name is ${name}.`]
      : ['I don’t have your name yet. Tell me by saying “my name is …” and I’ll remember it.'];
  }
  if (subject === 'style') {
    const style = mems.filter((m) => m.trim().length > 0 && !isNameNote(m));
    if (style.length === 0) {
      return ['I don’t have your trading style saved yet. Tell me something like “remember I prefer safer up bets”.'];
    }
    if (style.length === 1) return [`${cap(personalizeMemory(style[0]))}.`];
    return ['Here’s how you like to trade:', ...style.map((m) => `• ${personalizeMemory(m)}`)];
  }
  if (mems.length === 0) {
    return ['I don’t have anything saved about you yet. Tell me a preference like “remember I prefer safer up bets” and I’ll keep it.'];
  }
  if (mems.length === 1) return [`I remember that ${personalizeMemory(mems[0])}.`];
  return ['Here’s what I remember about you:', ...mems.map((m) => `• ${personalizeMemory(m)}`)];
}

/**
 * The welcome-back bubble for a RETURNING trader. Name-forward and light: it greets by name
 * when Kelly knows it, and otherwise nudges once for it — deliberately NOT the old "here's
 * everything I remember" list every visit (that lives behind the explicit "what do you
 * remember about me?" ask now). Returns [] when there's nothing to say (a brand-new trader
 * with no notes), so the caller shows only the normal greeting.
 */
export function welcomeBackLines(memories: string[]): string[] {
  const name = rememberedName(memories);
  if (name) {
    return [`Hey ${name}, good to see you back. Want to pick up where we left off, or try something new?`];
  }
  const hasNotes = memories.some((m) => m.trim().length > 0);
  if (!hasNotes) return [];
  return ['Good to see you back. Tell me your name and I’ll greet you by it next time, and I’ll tailor bets to how you like to trade.'];
}

/**
 * The same welcome-back line(s) from a cached hint (name + hasNotes) instead of a fresh
 * recall, so a returning trader's greeting can paint before the async recall returns.
 * Delegates to welcomeBackLines so the wording lives in one place: a known name greets by
 * it, notes-but-no-name gives the name nudge, and nothing gives no line.
 */
export function welcomeBackFromHint(hint: { name: string | null; hasNotes: boolean }): string[] {
  if (hint.name) return welcomeBackLines([`your name is ${hint.name}`]);
  return welcomeBackLines(hint.hasNotes ? ['note'] : []);
}

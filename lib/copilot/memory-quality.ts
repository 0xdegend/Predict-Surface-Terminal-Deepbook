/**
 * lib/copilot/memory-quality.ts — a guard against low-value "memory" fragments.
 *
 * A loose "remember that …" parse can pick up filler like "from now" or "for later"
 * (the tail of "…make sure you remember that from now"). This module decides whether a
 * fragment is worth keeping, and is used at BOTH ends of memory: we refuse to STORE a
 * fragment with no real content, and we HIDE any already-stored junk when recalling — so
 * a leftover fragment never surfaces in Kelly's memory list (there's no per-item delete
 * on Walrus Memory, so a display-time filter is how we retire one).
 *
 * Pure and side-effect free, so it's unit-tested and safe to import on both the client
 * (the intent parser) and the server (the recall wrapper).
 */

/** Function words plus generic temporal / filler adverbs that carry no standalone
 *  meaning. Domain words (up, down, range, long, short, bull, bear) are deliberately
 *  NOT here — they're real content in a trading note. Compared lowercased. */
const FILLER = new Set([
  'from', 'now', 'later', 'then', 'that', 'this', 'it', 'its', 'for', 'to', 'the', 'a', 'an',
  'of', 'on', 'in', 'at', 'by', 'and', 'or', 'so', 'but', 'please', 'ok', 'okay', 'sure',
  'thanks', 'thank', 'you', 'your', 'me', 'my', 'mine', 'i', 'is', 'am', 'are', 'was', 'were',
  'be', 'been', 'will', 'would', 'can', 'could', 'just', 'about', 'again', 'too', 'also',
  'here', 'there', 'soon', 'today', 'tomorrow', 'yesterday', 'always', 'never', 'ever',
  'some', 'any', 'all', 'as', 'with', 'without', 'onward', 'onwards', 'going', 'forward',
]);

/**
 * True when `text` carries at least one real content word (something worth remembering),
 * false for empty, too-short, or all-filler fragments like "from now" or "for later".
 * Conservative by design: any note with a single non-filler word survives, so real
 * preferences ("loves BTC", "your name is Degendev") are never dropped.
 */
export function isMeaningfulMemory(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 3) return false;
  const tokens = trimmed.toLowerCase().split(/[^a-z0-9%$]+/).filter(Boolean);
  return tokens.some((tok) => tok.length >= 2 && !FILLER.has(tok));
}

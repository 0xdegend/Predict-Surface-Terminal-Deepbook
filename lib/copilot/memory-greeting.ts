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
    ...picked.map((m) => `• ${m}`),
    'Want to pick up from there, or try something new?',
  ];
}

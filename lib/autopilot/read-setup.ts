/**
 * lib/autopilot/read-setup.ts — turn one line of a trader's English into a setup intent.
 *
 * Two readers, and the result is the UNION of them rather than a choice between them:
 *
 *   rules  — lib/autopilot/setup-parser. Instant, offline, unit-tested, handles the
 *            phrasings it was written for.
 *   model  — /api/kelly/autopilot/setup. Handles everything else ("keep me out of
 *            trouble, fifty bucks, till lunch"), and is optional.
 *
 * `mergeIntents(rules, ai)` lets the model override a field it actually read, and falls
 * back to the rule reading everywhere it stayed silent. So the model can only ever ADD
 * understanding: with no API key, a timeout, a daily cap, an offline browser or a
 * malformed payload, this returns exactly what shipped before.
 *
 * Every number the model produces goes through `sanitizeIntent` first, which drops
 * anything out of range instead of clamping it. A dropped field becomes a question the
 * trader answers; a clamped one would have become an amount they never chose.
 */
import {
  parseSetup,
  sanitizeIntent,
  mergeIntents,
  type SetupIntent,
  type SetupGap,
} from './setup-parser';
import type { SetupAiReply, SetupAiRequest } from './setup-ai';

export interface SetupRead {
  intent: SetupIntent;
  /** Kelly's one-line acknowledgement, when the model wrote one. */
  note?: string;
  /** Which reader actually contributed. 'rules' means the model added nothing. */
  source: 'ai' | 'rules';
}

/** Give up on the model well before the server's own 12s, so the UI never feels stuck. */
const CLIENT_TIMEOUT_MS = 9_000;

export async function readSetup(input: {
  message: string;
  known: SetupAiRequest['known'];
  asking: SetupGap[];
  /** Injected in tests. */
  fetchImpl?: typeof fetch;
}): Promise<SetupRead> {
  const rules = parseSetup(input.message);

  const ai = await tryModel(input);
  if (!ai) return { intent: rules, source: 'rules' };

  const merged = mergeIntents(rules, sanitizeIntent(ai.intent));
  // If the model read nothing the rules had not already caught, say so honestly rather
  // than crediting it, so the `source` seam stays useful for debugging.
  const addedSomething = JSON.stringify(merged) !== JSON.stringify(rules);
  return { intent: merged, note: ai.note, source: addedSomething || ai.note ? 'ai' : 'rules' };
}

async function tryModel(input: {
  message: string;
  known: SetupAiRequest['known'];
  asking: SetupGap[];
  fetchImpl?: typeof fetch;
}): Promise<SetupAiReply | null> {
  const doFetch = input.fetchImpl ?? (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return null;

  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), CLIENT_TIMEOUT_MS) : null;
  try {
    const res = await doFetch('/api/kelly/autopilot/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        message: input.message,
        known: input.known,
        asking: input.asking,
      } satisfies SetupAiRequest),
      signal: ctrl?.signal,
    });
    if (!res.ok) return null;
    const reply = (await res.json()) as SetupAiReply;
    return reply?.available ? reply : null;
  } catch {
    // Offline, aborted, non-JSON, anything at all: the rule reading still stands.
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

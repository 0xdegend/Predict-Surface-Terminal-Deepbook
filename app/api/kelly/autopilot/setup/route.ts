/**
 * /api/kelly/autopilot/setup — Kelly's optional LLM tier for reading an Autopilot
 * setup out of plain English. Server-only.
 *
 * The rule parser (lib/autopilot/setup-parser) handles the phrasings it was written
 * for and is instant, offline and unit-tested. It is still the floor: this route is a
 * READER that sits in front of it, so a trader can say "keep me out of trouble, fifty
 * bucks, till lunch" and be understood, and anything this route cannot do falls back
 * to the rules with no visible failure.
 *
 * IT DOES NOT DECIDE ANYTHING. The model is forced through a tool schema and returns a
 * proposal; the caller runs `sanitizeIntent` (which drops out-of-range values rather
 * than clamping them), then `missingFrom` to work out what still has to be asked, then
 * the pure `resolveSetup` to turn it into settings. Nothing here arms a run, moves
 * money, or writes to the store. That keeps the app's standing rule intact: money
 * paths stay deterministic, and the LLM only ever reads language.
 *
 * COST CONTROLS mirror /api/copilot:
 *   • Haiku 4.5, one forced tool call, no round trips.
 *   • Small max_tokens (the reply is a handful of fields).
 *   • Prompt caching on the stable system prompt.
 *   • Truncated input, so a giant paste cannot balloon the bill.
 *   • A per-day cap that degrades to the rule parser once hit.
 *   • A 12s timeout and no retries.
 */
import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { SETUP_TOOL_SCHEMA, plainPunctuation, type SetupAiRequest, type SetupAiReply } from '@/lib/autopilot/setup-ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODEL = process.env.COPILOT_AI_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;
const TIMEOUT_MS = 12_000;
const DAILY_CAP = Number(process.env.AUTOPILOT_AI_DAILY_CAP) || 300;
const MAX_MESSAGE_CHARS = 400;

const TOOL_NAME = 'record_setup';

// Stable, so it bills at ~10% after the first call each cache window. Editing busts it.
const SYSTEM_PROMPT = `You are Kelly, a co-pilot inside Skew, a Bitcoin prediction-market app. A trader is setting up Autopilot, which places small automated bets for them.

Your ONLY job is to read what they said into the ${TOOL_NAME} tool. You are a reader, not an adviser and not a decision maker.

Rules, every time:
- Call ${TOOL_NAME} exactly once.
- Only fill a field the trader actually expressed. Leave everything else unset. An unset field becomes a question the app asks them; a guessed field becomes money they did not choose to risk.
- NEVER invent, estimate, round up, or infer an amount of money. If they did not say a number, leave budgetUsd unset, even if that leaves the setup incomplete. This is the most important rule.
- Do not infer a budget from the style. "Go bold" says nothing about how much.
- The "already known" values are context for resolving references like "make it double that" or "same as before". Do not copy them back unless the trader is restating or changing them.
- If they are answering a specific question the app asked, read a bare answer as that field. Asked for a budget, "50" means budgetUsd 50. Asked how long, "20" means durationMins 20.
- Treat vague risk language generously: "keep me out of trouble", "don't lose my shirt", "steady", "send it", "let it rip" all express a style.
- The note is one short friendly sentence in plain words, stating any dollar amount out loud. No em dashes, no jargon, no emojis.`;

function underDailyCap(): boolean {
  const g = globalThis as typeof globalThis & { __apSetupDay?: string; __apSetupCount?: number };
  const today = new Date().toISOString().slice(0, 10);
  if (g.__apSetupDay !== today) {
    g.__apSetupDay = today;
    g.__apSetupCount = 0;
  }
  return (g.__apSetupCount ?? 0) < DAILY_CAP;
}
function bumpDailyCount(): void {
  const g = globalThis as typeof globalThis & { __apSetupCount?: number };
  g.__apSetupCount = (g.__apSetupCount ?? 0) + 1;
}

const OFF: SetupAiReply = { available: false };

let client: Anthropic | null = null;
function anthropic(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  return client;
}

/** What Kelly already has, spelled out so the model can resolve references to it. */
function knownBlock(known: SetupAiRequest['known']): string {
  const bits: string[] = [];
  if (known.style) bits.push(`style: ${known.style}`);
  if (known.budgetUsd != null) bits.push(`total budget: $${known.budgetUsd}`);
  if (known.durationMins != null) bits.push(`run length: ${known.durationMins} minutes`);
  if (known.live != null) bits.push(`mode: ${known.live ? 'live' : 'watch'}`);
  return bits.length ? bits.join(', ') : 'nothing yet';
}

const GAP_WORDS: Record<string, string> = {
  style: 'how much risk they want (cautious, balanced, or bold)',
  budget: 'the total dollar amount they want to put in',
  duration: 'how long the run should last',
};

export async function POST(req: Request): Promise<NextResponse<SetupAiReply>> {
  const ai = anthropic();
  if (!ai || !underDailyCap()) return NextResponse.json(OFF);

  let body: SetupAiRequest;
  try {
    body = (await req.json()) as SetupAiRequest;
  } catch {
    return NextResponse.json(OFF);
  }

  const message = (body?.message ?? '').toString().trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return NextResponse.json(OFF);

  const known = body?.known ?? {};
  const asking = Array.isArray(body?.asking) ? body.asking.slice(0, 3) : [];
  const askingLine = asking.length
    ? `The app just asked them for ${asking.map((g) => GAP_WORDS[g] ?? g).join(', then ')}.`
    : 'The app has not asked them anything specific yet.';

  const userContent = `Already known: ${knownBlock(known)}\n${askingLine}\n\nThe trader just said: ${message}`;

  try {
    bumpDailyCount(); // count the attempt, so a failing loop still caps
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: [
        {
          name: TOOL_NAME,
          description: 'Record what the trader expressed about how Autopilot should run.',
          input_schema: SETUP_TOOL_SCHEMA,
        },
      ],
      tool_choice: { type: 'tool', name: TOOL_NAME },
      messages: [{ role: 'user', content: userContent }],
    });

    const call = resp.content.find((b) => b.type === 'tool_use' && b.name === TOOL_NAME);
    if (!call || call.type !== 'tool_use') return NextResponse.json(OFF);

    const input = (call.input ?? {}) as Record<string, unknown>;
    // The prompt asks for plain punctuation; this enforces it. The model wrote
    // "Got it—running for half an hour" on the very first live run.
    const rawNote = typeof input.note === 'string' ? input.note.slice(0, 160) : '';
    const note = rawNote ? plainPunctuation(rawNote) || undefined : undefined;
    // The intent is passed through raw. The client sanitizes it, because that is where
    // the bounds live and it must run on the rule path too.
    return NextResponse.json({ available: true, intent: input, note });
  } catch {
    return NextResponse.json(OFF);
  }
}

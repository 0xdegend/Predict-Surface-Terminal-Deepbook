/**
 * /api/copilot — Kelly's optional LLM tier (Claude Haiku), server-only.
 *
 * The hybrid, read-only slice: the client calls this ONLY for the read long tail
 * (questions the rule router drops to `help`). Money-touching paths — quotes, bet
 * setup, placement, adjust, close — never reach here; they stay 100% deterministic.
 * Claude is grounded in a compact, pre-fetched context the client sends, so it never
 * invents a price/probability/result and never places a trade. Any failure returns
 * `{ available: false }` so the client falls back to the deterministic help reply.
 *
 * COST CONTROLS (all on by default):
 *   • Haiku 4.5 — the cheap, fast read model.
 *   • ONE completion per question (context passed in; no tool round trips).
 *   • Small max_tokens (replies are 2-3 short lines).
 *   • Prompt caching on the stable system prompt (cache_control: ephemeral).
 *   • Trimmed history + truncated inputs (a giant paste can't balloon the bill).
 *   • A per-day cap (in-process) that degrades to the rule reply once hit.
 *   • A 15s timeout + no retries, so a hung call can't linger or double-spend.
 *
 * Gated on ANTHROPIC_API_KEY being present (server-only, never NEXT_PUBLIC). With no
 * key it always returns `{ available: false }`, i.e. pure rules, zero spend.
 */
import { NextResponse } from 'next/server';
import Anthropic from '@anthropic-ai/sdk';
import { formatAiContext, type AiRequest, type AiReply } from '@/lib/copilot/ai';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Haiku 4.5 — overridable, but defaults to the cheap read model on purpose.
const MODEL = process.env.COPILOT_AI_MODEL || 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 320; // replies are short; caps the priciest half of each call.
const TIMEOUT_MS = 15_000;
// Per-day spend guard. ~$0.01/call on Haiku, so 300/day ≈ a few dollars/day ceiling
// even under a runaway loop. Override with COPILOT_AI_DAILY_CAP.
const DAILY_CAP = Number(process.env.COPILOT_AI_DAILY_CAP) || 300;

// Input caps — the client trims too, but never trust the client with token cost.
const MAX_MESSAGE_CHARS = 600;
const MAX_HISTORY_TURNS = 4;
const MAX_TURN_CHARS = 300;

// The stable persona — cached (cache_control below) so it bills at ~10% after the
// first call each ~5 minutes. Keep it STABLE; editing it busts the cache.
const SYSTEM_PROMPT = `You are Kelly, a friendly co-pilot inside Skew, a Bitcoin prediction-market trading app (DeepBook Predict on Sui). Traders ask you plain-language questions about BTC and about their own trading.

Follow these rules every time:
- Answer in plain, everyday language. Keep it to 2-3 short sentences. No jargon (never use: implied vol, sigma, skew, delta, gamma, theta, moneyness, basis). No emojis.
- Never use em dashes. Use commas, periods, or parentheses instead.
- Use ONLY the facts under "Context". Never invent or estimate a price, a probability, a payout, or a trade result. If the Context does not contain what is needed, say you do not have that yet and suggest what they can ask (for example "ask me to analyze BTC" or "ask what's my win rate").
- You are read-only. You never place, change, or close a trade, and you must never claim you did. If they want to trade, tell them to say a direction like "safe up bet", or say "set up a trade" and the app will walk them through it.
- Do not give financial advice or tell them what they should do. You can describe what the data shows.
- If they ask about their balance or track record and the Context says the wallet is not connected, tell them to connect it from the top right first.`;

/** In-process per-day counter (resets on date change). Best-effort — one server
 *  instance; good enough as a spend ceiling for beta. */
function underDailyCap(): boolean {
  const g = globalThis as typeof globalThis & { __kellyAiDay?: string; __kellyAiCount?: number };
  const today = new Date().toISOString().slice(0, 10);
  if (g.__kellyAiDay !== today) {
    g.__kellyAiDay = today;
    g.__kellyAiCount = 0;
  }
  return (g.__kellyAiCount ?? 0) < DAILY_CAP;
}
function bumpDailyCount(): void {
  const g = globalThis as typeof globalThis & { __kellyAiCount?: number };
  g.__kellyAiCount = (g.__kellyAiCount ?? 0) + 1;
}

const OFF: AiReply = { available: false };

let client: Anthropic | null = null;
function anthropic(): Anthropic | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new Anthropic({ apiKey, timeout: TIMEOUT_MS, maxRetries: 0 });
  return client;
}

export async function POST(req: Request): Promise<NextResponse<AiReply>> {
  const ai = anthropic();
  // No key, or the daily spend ceiling is hit → pure rules, no spend.
  if (!ai || !underDailyCap()) return NextResponse.json(OFF);

  let body: AiRequest;
  try {
    body = (await req.json()) as AiRequest;
  } catch {
    return NextResponse.json(OFF);
  }

  const message = (body?.message ?? '').toString().trim().slice(0, MAX_MESSAGE_CHARS);
  if (!message) return NextResponse.json(OFF);

  const history = Array.isArray(body?.history) ? body.history.slice(-MAX_HISTORY_TURNS) : [];
  const transcript = history.length
    ? `Recent conversation:\n${history
        .map((t) => `${t.role === 'user' ? 'Trader' : 'Kelly'}: ${(t.text ?? '').toString().slice(0, MAX_TURN_CHARS)}`)
        .join('\n')}\n\n`
    : '';
  const contextBlock = formatAiContext(body?.context ?? {});

  const userContent = `${transcript}Context (the only facts you may use — do not invent anything beyond these):\n${contextBlock}\n\nTrader's question: ${message}`;

  try {
    bumpDailyCount(); // count the attempt (before the call) so a failing loop still caps
    const resp = await ai.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      temperature: 0.4,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: userContent }],
    });
    const text = resp.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim();
    if (!text) return NextResponse.json(OFF);
    // One string per paragraph (blank-line separated), matching the chat's line model.
    const lines = text.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
    return NextResponse.json({ available: true, text: lines.length ? lines : [text] });
  } catch {
    // Timeout, rate limit, transient error → fall back to rules silently.
    return NextResponse.json(OFF);
  }
}

/**
 * lib/autopilot/setup-ai.ts — the wire types for Kelly's optional LLM setup reader.
 *
 * WHAT THE MODEL IS TRUSTED WITH: reading a sentence of English into a structured
 * intent. That is all. It never picks a number, never decides a style on the trader's
 * behalf, and never arms anything.
 *
 * The app already draws this line for the co-pilot (/api/copilot): money-touching paths
 * stay deterministic. Autopilot setup IS a money path, so the line is held the same way
 * here, by construction rather than by prompt:
 *
 *   1. The model returns a proposal, not a decision.
 *   2. `sanitizeIntent` re-checks every field against the same bounds the rule parser
 *      uses, and DROPS anything out of range instead of clamping it, so an invented
 *      number turns into a question rather than a plausible-looking assumption.
 *   3. `missingFrom` then decides what Kelly still has to ask for.
 *   4. `resolveSetup` (pure, tested) turns the finished intent into panel settings.
 *   5. The plan line and the Start button are still the trader's confirm.
 *
 * With no ANTHROPIC_API_KEY, or on any error, timeout or cap, the route returns
 * `{ available: false }` and the caller falls back to the rule parser. The feature
 * degrades to exactly what shipped before, at zero spend.
 */
import type { PresetId } from './presets';
import type { SetupGap } from './setup-parser';

export interface SetupAiRequest {
  /** What the trader just typed. */
  message: string;
  /** What Kelly already has, so "make it twenty" resolves against the right field. */
  known: {
    style?: PresetId;
    budgetUsd?: number;
    durationMins?: number;
    live?: boolean;
  };
  /** The gap Kelly just asked about, so a bare "50" is read as an answer to it. */
  asking: SetupGap[];
}

export interface SetupAiReply {
  /** False = no key / disabled / capped / errored → the caller uses the rule parser. */
  available: boolean;
  /** Raw tool payload. Always passed through `sanitizeIntent` before use. */
  intent?: unknown;
  /** One short line Kelly can say back, e.g. "Got it, cautious with $25." */
  note?: string;
}

/** Fields the model may fill in. Kept next to the request so both sides agree. */
export const SETUP_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    style: {
      type: 'string' as const,
      enum: ['cautious', 'balanced', 'bold'],
      description:
        'How much risk the trader wants. cautious = play it safe / careful / conservative. balanced = steady, middle of the road. bold = aggressive, risky, swing for it, degen. Only set this if the trader actually expressed a risk appetite.',
    },
    budgetUsd: {
      type: 'number' as const,
      description:
        'The TOTAL amount in dollars the trader is willing to put in across the whole run. Only set this if they stated an amount. Never guess, never infer from the style, never carry over a number you were shown as already known.',
    },
    perTradeUsd: {
      type: 'number' as const,
      description:
        'Dollars per individual bet, only if they said something like "$5 a bet" or "five each". Leave unset otherwise; it is normally derived from the budget.',
    },
    durationMins: {
      type: 'number' as const,
      description:
        'How long the run should last, in minutes. "an hour" = 60, "half an hour" = 30, "the rest of the day" = 120. Only set if they said how long.',
    },
    live: {
      type: 'boolean' as const,
      description:
        'true if they asked to trade for real, false if they asked to watch / practise / paper trade / do a dry run. Leave unset if they did not say.',
    },
    note: {
      type: 'string' as const,
      description:
        'One short, friendly sentence confirming what you understood, in plain words. Mention any dollar amount explicitly. No em dashes. Max 120 characters.',
    },
  },
  required: [] as string[],
};

/**
 * Strip em/en dashes out of a model-written line.
 *
 * The system prompt asks for none, and the model still produced "Got it—running for
 * half an hour" on the first live run. A prompt is a request, not a guarantee, so the
 * house rule (plain punctuation in anything a trader reads) is enforced here in code,
 * where it actually holds. Kept pure and next to the wire types because this is the
 * boundary the model's words cross into the UI.
 */
export function plainPunctuation(text: string): string {
  return text
    .replace(/\s*[\u2014\u2013]\s*/g, ', ')
    .replace(/,\s*,/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,\s*([.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

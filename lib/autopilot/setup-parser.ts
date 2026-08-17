// "Set it up for me" — turns a plain sentence into an Autopilot setup proposal.
//
// The trader taps "Set it up for me" and says something like "keep it safe, $25 for
// an hour" or "go bold with $100". This pure parser reads that into a SetupIntent
// (which style, how much, how long, watch vs live). Nothing here arms anything: the
// intent is applied to the visible panel, where the plan line and the Start button
// stay the source of truth and the trader confirms before anything runs. Money is
// always echoed back explicitly, never silently assumed.
//
// Rule-based (no LLM) so it's instant, offline, and unit-tested. It errs toward the
// safe default (Balanced, the trader's current money, their current mode) whenever a
// phrase is ambiguous, because the panel shows exactly what it chose before running.
import type { PresetId } from './presets';
import { PRESET_BY_ID } from './presets';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export interface SetupIntent {
  /** The style Kelly should use. Always resolved; defaults to 'balanced'. */
  preset: PresetId;
  /** Whether the text actually named a style (vs falling back to the default). */
  presetNamed: boolean;
  /** A total budget, if the trader named one. */
  budgetUsd?: number;
  /** A per-bet size, if the trader named one ("$5 a bet"). */
  perTradeUsd?: number;
  /** A run length in minutes, if the trader named one. */
  durationMins?: number;
  /** Watch (false) or live (true), if the trader named a mode. */
  live?: boolean;
}

/** A setup with every field filled in — what actually gets applied to the panel. */
export interface ResolvedSetup {
  preset: PresetId;
  budgetUsd: number;
  perTradeUsd: number;
  durationMins: number;
  /** Only set when the trader named a mode; otherwise the panel keeps its current one. */
  live?: boolean;
}

const STYLE_WORDS: { id: PresetId; re: RegExp }[] = [
  { id: 'cautious', re: /\b(cautious|careful|safe(?:ly|st|ty)?|conservative|low[-\s]?risk|play it safe|defensive)\b/i },
  { id: 'bold', re: /\b(bold|aggressive|risky|risk[-\s]?on|high[-\s]?risk|swing for|yolo|degen|go big|send it)\b/i },
  { id: 'balanced', re: /\b(balanced|steady|moderate|middle|sensible|normal|default|even mix)\b/i },
];

function detectLive(text: string): boolean | undefined {
  if (/\b(watch|practice|rehears(?:e|al|ing)|paper|sim(?:ulat\w*)?|demo|pretend|dry[-\s]?run|no money|without spending)\b/i.test(text)) {
    return false;
  }
  if (/\b(live|real money|for real|actually trade|really trade|use real|with real|real trades)\b/i.test(text)) {
    return true;
  }
  return undefined;
}

const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5 };

/**
 * Pull a run length (in minutes) out of the text and return the text with that phrase
 * removed, so the money parser can't mistake "30 minutes" for a "$30" budget. Tries the
 * most specific phrasings first (half an hour, N hours, N minutes).
 */
function extractDuration(text: string): { mins?: number; rest: string } {
  let rest = text;
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => number): number | undefined => {
    const m = rest.match(re);
    if (!m || m.index == null) return undefined;
    rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
    return fn(m);
  };
  let mins: number | undefined;
  mins ??= take(/half\s+an?\s+hour|half\s+hour/i, () => 30);
  mins ??= take(/all\s+day|rest of (?:the day|today)/i, () => 120);
  mins ??= take(/(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)\b/i, (m) => Math.round(parseFloat(m[1]) * 60));
  mins ??= take(/\b(an?|one|two|three|four|five)\s+hours?\b/i, (m) => WORD_NUM[m[1].toLowerCase()] * 60);
  mins ??= take(/(\d+)\s*(?:minutes?|mins?|m)\b/i, (m) => parseInt(m[1], 10));
  if (mins != null) mins = clamp(mins, 5, 24 * 60);
  return { mins, rest };
}

/**
 * Pull a total budget and/or a per-bet size out of the text. Per-bet phrasings ("$5 a
 * bet", "each trade $5") are matched and removed first, so what remains is read as the
 * budget: a $-prefixed number wins, then a keyword-led one ("risk 20"), then a lone number.
 */
function extractMoney(text: string): { budgetUsd?: number; perTradeUsd?: number } {
  // Drop tokens that look like money but aren't ("2x" leverage, "70%" odds).
  let rest = text.replace(/\b\d+\s*x\b/gi, ' ').replace(/\d+(?:\.\d+)?\s*%/g, ' ');
  let perTradeUsd: number | undefined;
  let budgetUsd: number | undefined;

  const perPatterns = [
    /\$?\s*(\d+(?:\.\d+)?)\s*(?:(?:a|per)\s+(?:bet|trade)|each|apiece|\/\s*(?:bet|trade))/i,
    /(?:each|per\s+(?:bet|trade)|a\s+(?:bet|trade))\s*(?:of|:|=)?\s*\$?\s*(\d+(?:\.\d+)?)/i,
  ];
  for (const re of perPatterns) {
    const m = rest.match(re);
    if (m && m.index != null) {
      perTradeUsd = parseFloat(m[1]);
      rest = `${rest.slice(0, m.index)} ${rest.slice(m.index + m[0].length)}`;
      break;
    }
  }

  const dollar = rest.match(/\$\s*(\d+(?:\.\d+)?)/);
  const keyword = rest.match(/(?:budget|risk|spend|stake|use|with|about|around|roughly|up to|~)\s*\$?\s*(\d+(?:\.\d+)?)/i);
  const lone = rest.match(/\b(\d+(?:\.\d+)?)\b/);
  const b = dollar ?? keyword ?? lone;
  if (b) budgetUsd = parseFloat(b[1]);

  return {
    perTradeUsd: perTradeUsd != null ? clamp(Math.round(perTradeUsd), 1, 100_000) : undefined,
    budgetUsd: budgetUsd != null ? clamp(Math.round(budgetUsd), 1, 100_000) : undefined,
  };
}

/** Read a plain sentence into a setup proposal. Never throws; unknowns stay undefined. */
export function parseSetup(input: string): SetupIntent {
  const text = ` ${input.trim()} `;
  let preset: PresetId = 'balanced';
  let presetNamed = false;
  for (const s of STYLE_WORDS) {
    if (s.re.test(text)) {
      preset = s.id;
      presetNamed = true;
      break;
    }
  }
  const live = detectLive(text);
  const { mins, rest } = extractDuration(text);
  const money = extractMoney(rest);
  return {
    preset,
    presetNamed,
    budgetUsd: money.budgetUsd,
    perTradeUsd: money.perTradeUsd,
    durationMins: mins,
    live,
  };
}

/**
 * Fill an intent's gaps from the panel's current money/time so it's ready to apply.
 * When a budget is named but no per-bet size, size the bet so the budget covers roughly
 * the preset's trade count (e.g. $25 over Balanced's 5 trades ≈ $5 each). Everything is
 * clamped to sane bounds, and the per-bet can never exceed the budget.
 */
export function resolveSetup(
  intent: SetupIntent,
  current: { budgetUsd: number; perTradeUsd: number; armDurationMs: number },
): ResolvedSetup {
  const shape = PRESET_BY_ID[intent.preset].shape;
  const budgetUsd = clamp(intent.budgetUsd ?? current.budgetUsd, 1, 100_000);
  const proposedPer =
    intent.perTradeUsd ??
    (intent.budgetUsd != null ? Math.max(1, Math.round(budgetUsd / shape.maxTrades)) : current.perTradeUsd);
  const perTradeUsd = clamp(proposedPer, 1, budgetUsd);
  const durationMins = intent.durationMins ?? Math.round(current.armDurationMs / 60_000);
  return { preset: intent.preset, budgetUsd, perTradeUsd, durationMins, live: intent.live };
}

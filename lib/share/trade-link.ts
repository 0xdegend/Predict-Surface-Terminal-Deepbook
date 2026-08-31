/**
 * lib/share/trade-link.ts — the "trade recipe" that a shareable trade link carries,
 * plus its encode / decode. Pure and isomorphic (no browser or Sui imports), so the
 * same code runs in the share modal (client), the recipient route (server), and the
 * dynamic OG image (edge) — and the round-trip is unit-testable.
 *
 * WHY a recipe and not a market id: Skew markets are sub-minute, so the exact market
 * the sender picked is almost always gone by the time a friend opens the link. The
 * link instead carries the SHAPE of the trade — its tenor (which market family), the
 * direction/level, and the sender's size + leverage — which Phase 1 re-resolves
 * against the current live market (see resolve-recipe.ts). The strike is an absolute
 * price; if it's omitted, the recipient's ticket follows the current at-the-money.
 *
 * Decoding is defensive: a link is attacker-controllable, so decodeRecipe validates
 * structure, clamps numbers to sane bounds, sanitizes the attribution string, and
 * returns null on anything malformed. It never throws and it never executes — the
 * ticket always re-quotes on-chain and the friend confirms.
 */

/** Bump when the wire shape changes; decode rejects any other version. */
export const RECIPE_VERSION = 1;

/**
 * Market cadence families (must match config/predict.ts cadence `name`s).
 *
 * Widened for 8-21, which lists 1-day and 1-week markets. This is a WIRE format: a recipe is
 * serialized into a share URL and re-resolved by whoever opens it, so the direction of the
 * change matters. Adding values is safe, because every link already in the wild names one of
 * the original three and still parses. A link naming '1w' opened against an older build
 * fails the parse and falls back, which is the correct outcome rather than a mis-resolved
 * trade on the wrong horizon. Removing or renaming a value would break live links.
 */
export const RECIPE_TENORS = ['1m', '5m', '1h', '1d', '1w'] as const;
export type RecipeTenor = (typeof RECIPE_TENORS)[number];
export type RecipeMode = 'binary' | 'range';

export interface TradeRecipe {
  v: typeof RECIPE_VERSION;
  /** Which market family to re-resolve into. */
  tenor: RecipeTenor;
  mode: RecipeMode;
  /** binary: pays when settlement is ABOVE the strike. */
  isUp?: boolean;
  /** binary strike, absolute $. Omitted = follow the current at-the-money. */
  strike?: number;
  /** range band edges, absolute $ (lower < higher). */
  lower?: number;
  higher?: number;
  /** The sender's stake, in DUSDC. */
  stake: number;
  /** Leverage multiple (1 = none). */
  lev: number;
  /** Sender attribution: a display name, handle, or builder code. */
  ref?: string;
}

// Sane bounds. The recipient's ticket + resolver re-clamp against the real market
// (its max leverage, admission band, and the wallet balance); these just keep a
// hostile or corrupt token from injecting NaN / Infinity / absurd values.
const MAX_STAKE = 1_000_000;
const MAX_LEV = 100;
const MAX_REF_LEN = 40;
const MAX_TOKEN_LEN = 512;

const isFiniteNum = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(n, lo), hi);
const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Trim, strip control characters, and cap the length of the attribution string.
 * Filters by code point (drops U+0000–U+001F and U+007F) rather than a regex, so no
 * control bytes live in this source file.
 */
function cleanRef(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let s = '';
  for (const ch of raw) {
    const c = ch.codePointAt(0)!;
    if (c >= 0x20 && c !== 0x7f) s += ch;
  }
  s = s.trim().slice(0, MAX_REF_LEN);
  return s.length ? s : undefined;
}

/**
 * Validate + clamp an untrusted object into a clean TradeRecipe, or null. Shared by
 * decodeRecipe (untrusted token) and buildRecipe (sender-side inputs) so there is a
 * single normalization path. Structural problems (bad version/tenor/mode, a range
 * with no valid band, a missing binary direction) reject; soft problems (an
 * out-of-range stake or leverage, a bad strike) clamp or fall back.
 */
export function normalizeRecipe(raw: unknown): TradeRecipe | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;

  if (r.v !== RECIPE_VERSION) return null;
  if (!RECIPE_TENORS.includes(r.tenor as RecipeTenor)) return null;
  if (r.mode !== 'binary' && r.mode !== 'range') return null;

  // Stake is required and must be positive; leverage is optional (defaults to none).
  if (!isFiniteNum(r.stake) || r.stake <= 0) return null;
  const stake = round2(clamp(r.stake, 0, MAX_STAKE));
  const lev = isFiniteNum(r.lev) ? round2(clamp(r.lev, 1, MAX_LEV)) : 1;
  const ref = cleanRef(r.ref);

  const out: TradeRecipe = { v: RECIPE_VERSION, tenor: r.tenor as RecipeTenor, mode: r.mode, stake, lev };
  if (ref) out.ref = ref;

  if (r.mode === 'binary') {
    if (typeof r.isUp !== 'boolean') return null; // direction is essential
    out.isUp = r.isUp;
    // A bad strike is not fatal: drop it and the ticket follows the ATM.
    if (isFiniteNum(r.strike) && r.strike > 0) out.strike = round2(r.strike);
  } else {
    if (!isFiniteNum(r.lower) || !isFiniteNum(r.higher) || r.lower <= 0 || r.higher <= 0) return null;
    if (r.lower === r.higher) return null;
    out.lower = round2(Math.min(r.lower, r.higher));
    out.higher = round2(Math.max(r.lower, r.higher));
  }
  return out;
}

/** Build a validated recipe from sender-side inputs (used by the share modal). */
export function buildRecipe(input: {
  tenor: RecipeTenor;
  mode: RecipeMode;
  isUp?: boolean;
  strike?: number | null;
  lower?: number | null;
  higher?: number | null;
  stake: number;
  lev: number;
  ref?: string;
}): TradeRecipe | null {
  return normalizeRecipe({
    v: RECIPE_VERSION,
    tenor: input.tenor,
    mode: input.mode,
    isUp: input.isUp,
    strike: input.strike ?? undefined,
    lower: input.lower ?? undefined,
    higher: input.higher ?? undefined,
    stake: input.stake,
    lev: input.lev,
    ref: input.ref,
  });
}

// --- URL-safe base64 of UTF-8, isomorphic (btoa/atob + TextEncoder exist in Node
//     18+, browsers, and the edge runtime). ---

function bytesToB64url(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlToBytes(token: string): Uint8Array {
  const pad = token.length % 4 === 0 ? '' : '='.repeat(4 - (token.length % 4));
  const b64 = token.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Recipe → compact URL-safe token for the /t/<token> path. Strips absent fields. */
export function encodeRecipe(recipe: TradeRecipe): string {
  // JSON.stringify already omits `undefined` values, keeping the token tight.
  return bytesToB64url(new TextEncoder().encode(JSON.stringify(recipe)));
}

/** Token → validated TradeRecipe, or null if malformed / tampered / oversized. */
export function decodeRecipe(token: string | null | undefined): TradeRecipe | null {
  if (!token || token.length > MAX_TOKEN_LEN) return null;
  try {
    const json = new TextDecoder().decode(b64urlToBytes(token));
    return normalizeRecipe(JSON.parse(json));
  } catch {
    return null;
  }
}

/** Plain-language one-liner for the banner, share text, and OG card. BTC-only today. */
export function recipeLabel(recipe: TradeRecipe): string {
  const usd = (n: number) =>
    '$' +
    (Number.isInteger(n)
      ? n.toLocaleString('en-US')
      : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

  let head: string;
  if (recipe.mode === 'range') {
    head = `BTC between ${usd(recipe.lower!)} and ${usd(recipe.higher!)}`;
  } else if (recipe.strike != null) {
    head = `BTC ${recipe.isUp ? 'above' : 'below'} ${usd(recipe.strike)}`;
  } else {
    head = `BTC ${recipe.isUp ? 'up' : 'down'} from here`;
  }
  const tail = `${usd(recipe.stake)}${recipe.lev > 1 ? ` · ${recipe.lev}x` : ''}`;
  return `${head} · ${tail}`;
}

/** The sender's post copy for X / Telegram / WhatsApp. Plain, no em-dashes. */
export function recipeShareText(recipe: TradeRecipe): string {
  return `I set up a trade on Skew: ${recipeLabel(recipe)}. Open it and place it in a tap.`;
}

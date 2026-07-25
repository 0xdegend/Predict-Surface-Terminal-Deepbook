/**
 * /api/insights/btc/narrative — the "what is X talking about?" aggregate that feeds
 * the co-pilot's "why is BTC moving?" answer.
 *
 * Pulls a curated X (Twitter) sample via Clawby PRO `x_search`, then does the hard,
 * unglamorous work that keeps it honest:
 *   1. a query with negative keywords to cut the worst giveaway spam at the source,
 *   2. a server-side spam regex + author-quality filter (followers or blue check),
 *   3. topic bucketing (macro / ETF / regulation / technicals) + a coarse mood tilt.
 *
 * It returns ONLY the aggregate (topic counts + mood), never a quoted post. Crypto X
 * is full of fabricated "BREAKING" clickbait, so restating a post as fact would be
 * misinformation. The rule-based read leans on hard market data for the actual "why"
 * (see lib/insights/narrative.ts) and uses this purely as a "what people discuss" layer.
 *
 * SERVER-ONLY (the Clawby key is a per-account secret). Cached in-process (5-min TTL
 * + single-flight, since chatter shifts slowly and x_search is the heaviest call),
 * degrades to `{ available:false }` with no key. The `ai` field is the seam a later
 * Claude slice fills; today it's always absent.
 */
import { NextResponse } from 'next/server';
import type { NarrativeFeed, NarrativeChatter, ChatterTopic } from '@/lib/insights/narrative';
import { relay, asList, hasClawbyKey } from '@/lib/insights/clawby-server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const TTL_MS = 300_000; // 5 minutes — chatter drifts slowly and x_search is heavy.

// A curated query: BTC + a market-relevant term, with the worst giveaway spam
// excluded at the source. The server-side filter below is the real defense.
const QUERY =
  '(bitcoin OR $BTC) (fed OR rate OR etf OR sec OR news OR breakout OR selloff OR rally OR crash OR dump OR pump OR liquidation OR whale) -giveaway -airdrop -winner -presale -"send you" -"drop your"';

// Second-line spam defense: giveaway / promo / engagement-farm patterns.
const SPAM =
  /giveaway|give ?away|giving away|send you|drop your|\baddress\b|winner|rt and follow|follow @|airdrop|presale|whitelist|link in bio|\bclaim\b|free \$|lucky|🎁|🎉|100x|1000x|guaranteed|dm me|t\.me\/|join now|sign ?up|promo code/i;

// Topic buckets (the "what people discuss") — kept distinct from the mood tilt.
const TOPICS: { label: string; re: RegExp }[] = [
  { label: 'macro and Fed policy', re: /\bfed\b|rate cut|\brates\b|\bcpi\b|inflation|fomc|powell|\bmacro\b|jobs report|liquidity|treasury|\bm2\b/i },
  { label: 'ETF and institutional flows', re: /\betf\b|blackrock|\bibit\b|fidelity|inflow|outflow|institution|saylor|microstrategy/i },
  { label: 'regulation and politics', re: /\bsec\b|regulat|lawsuit|congress|senate|\btrump\b|white house|executive order|government/i },
  { label: 'chart levels and technicals', re: /support|resistance|breakout|break ?down|\bfvg\b|retest|\b[5-9][0-9]k\b|trend ?line|\bchart\b/i },
];

// Directional mood words.
const MOOD_UP = /\bpump\b|rally|\bmoon\b|\bath\b|\bbull\b|\blong\b|surge|send it|new high|breakout|\bgreen\b|\bfomo\b/i;
const MOOD_DOWN = /\bdump\b|crash|sell-?off|\bshort\b|\bbear\b|breakdown|\btrap\b|warning|capitulat|\bbottom\b|tank|plunge|collaps|\bred\b|\bfear\b/i;

function textOf(p: Record<string, unknown>): string {
  const t = p.text ?? p.full_text ?? p.content ?? '';
  return typeof t === 'string' ? t : '';
}

/** Keep only non-spam posts from accounts with some reach (followers or blue check). */
function isQuality(p: Record<string, unknown>): boolean {
  const t = textOf(p);
  if (!t || SPAM.test(t)) return false;
  const u = (p.user ?? {}) as Record<string, unknown>;
  const followers = Number(u.followers_count ?? 0);
  const blue = u.is_blue_verified === true || u.verified === true;
  return (Number.isFinite(followers) && followers >= 500) || blue;
}

async function build(): Promise<NarrativeFeed> {
  const asOf = Date.now();
  let chatter: NarrativeChatter | null = null;

  try {
    const posts = asList(await relay('x_search', { query: QUERY, sort: 'Top', lang: 'en', min_likes: 40, count: 40 }));
    const kept = posts.filter(isQuality);

    if (kept.length > 0) {
      const topics: ChatterTopic[] = TOPICS.map(({ label, re }) => ({
        label,
        count: kept.filter((p) => re.test(textOf(p))).length,
      }))
        .filter((t) => t.count > 0)
        .sort((a, b) => b.count - a.count);

      let up = 0;
      let down = 0;
      for (const p of kept) {
        const t = textOf(p);
        if (MOOD_UP.test(t)) up++;
        if (MOOD_DOWN.test(t)) down++;
      }
      const moodScore = up + down > 0 ? (up - down) / (up + down) : 0;
      const mood = moodScore > 0.15 ? 'bullish' : moodScore < -0.15 ? 'bearish' : 'mixed';

      chatter = { sampleCount: kept.length, topics: topics.slice(0, 3), moodScore, mood, asOf };
    } else {
      chatter = { sampleCount: 0, topics: [], moodScore: 0, mood: 'mixed', asOf };
    }
  } catch {
    chatter = null; // the narrative still works from market data alone.
  }

  return { available: true, asOf, chatter };
}

// In-process cache + single-flight, so bursty traffic never fans out to Clawby.
const g = globalThis as unknown as {
  __btcNarrative?: { at: number; payload: NarrativeFeed };
  __btcNarrativeInflight?: Promise<NarrativeFeed> | null;
};

export async function GET() {
  if (!hasClawbyKey()) {
    return NextResponse.json({ available: false } satisfies Partial<NarrativeFeed>);
  }
  const now = Date.now();
  if (g.__btcNarrative && now - g.__btcNarrative.at < TTL_MS) {
    return NextResponse.json(g.__btcNarrative.payload);
  }
  try {
    if (!g.__btcNarrativeInflight) {
      g.__btcNarrativeInflight = build().finally(() => {
        g.__btcNarrativeInflight = null;
      });
    }
    const payload = await g.__btcNarrativeInflight;
    g.__btcNarrative = { at: Date.now(), payload };
    return NextResponse.json(payload);
  } catch {
    if (g.__btcNarrative) return NextResponse.json(g.__btcNarrative.payload);
    return NextResponse.json({ available: false } satisfies Partial<NarrativeFeed>);
  }
}
